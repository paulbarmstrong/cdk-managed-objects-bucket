import { execSync } from "child_process"
import path from "path"
import { Construct } from "constructs"
import { readdirSync } from "fs"
import * as cdk from "aws-cdk-lib"
import * as s3 from "aws-cdk-lib/aws-s3"
import * as cloudfront from "aws-cdk-lib/aws-cloudfront"
import * as lambda from "aws-cdk-lib/aws-lambda"
import * as iam from "aws-cdk-lib/aws-iam"
import * as logs from "aws-cdk-lib/aws-logs"
import * as s3_assets from "aws-cdk-lib/aws-s3-assets"

export type ManagedObjectsBucketProps = Partial<Omit<Omit<s3.BucketProps, "removalPolicy">, "autoDeleteObjects">> & {
	/** CloudWatch Log Group for the bucket object manager to send its logs to. */
	objectManagerLogGroup?: logs.ILogGroup
}

/** @hidden */
type InlineBucketObject = {
	key: string,
	body: string
}

type CloudFrontInvalidationObjectChangeActionProps = {
	/** CloudFront Distribution to create an invalidation for. */
	distribution: cloudfront.Distribution,
	/**
	 * Whether to wait for the invalidation to be completed before allowing the CloudFormation
	 * update to continue.
	 * @default false
	 */
	waitForCompletion?: boolean
}

/** 
 * An action to be performed when changes are made to the objects in the bucket.
 */
export abstract class ObjectChangeAction {
	/** @hidden */
	#classname = "ObjectChangeAction"
	/** ObjectChangeAction for performing a CloudFront invalidation after objects
	 * in the bucket have changed. */
	static cloudFrontInvalidation(props: CloudFrontInvalidationObjectChangeActionProps) {
		return new CloudFrontInvalidationObjectChangeAction(props)
	}
}

/** ObjectChangeAction for performing an invalidation on a CloudFront distribution after objects
 * in the bucket have changed. */
class CloudFrontInvalidationObjectChangeAction extends ObjectChangeAction {
	distribution: cloudfront.Distribution
	waitForCompletion?: boolean
	constructor(props: CloudFrontInvalidationObjectChangeActionProps) {
		super()
		this.distribution = props.distribution
		this.waitForCompletion = props.waitForCompletion
	}
}

/** 
 * An S3 Bucket where the objects in the bucket are completely managed by CDK. A
 * `Custom::ManagedBucketObjects` CFN resource internal to the ManagedObjectsBucket construct
 * mutates objects in the bucket to align the bucket with the objects defined in the CDK
 * definition. The objects in the bucket are otherwise read-only. Objects are added by calling
 * the `addObject` and `addObjectsFromAsset` methods.
 * 
 * ManagedObjectsBucket extends [Bucket](
 * https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_s3.Bucket.html). All props from
 * Bucket are allowed except:
 * 
 * 1. `removalPolicy` and `autoDeleteObjects` are not configurable. ManagedObjectsBuckets are
 * always emptied and destroyed on removal.
 * 
 * In the event of ManagedObjectsBucket's `Custom::ManagedBucketObjects` custom resource having
 * a persistent problem, you can unblock your stack by adding the following environment variable
 * to the ObjectManagerFunction lambda function also inside the stack:
 * 
 * Key: `SKIP`, Value: `true`
 */
export class ManagedObjectsBucket extends s3.Bucket {
	/** @hidden */
	#inlineBucketObjects: Array<InlineBucketObject>
	/** @hidden */
	#assets: Array<s3_assets.Asset>
	/** @hidden */
	#ObjectChangeActions: Array<ObjectChangeAction>
	/** @hidden */
	#handlerRole: iam.Role
	constructor(scope: Construct, id: string, props: ManagedObjectsBucketProps) {
		super(scope, id, {
			removalPolicy: cdk.RemovalPolicy.DESTROY,
			...props
		})
		this.#inlineBucketObjects = []
		this.#assets = []
		this.#ObjectChangeActions = []

		const codePackagePath = path.join(__dirname, "..", "..", "handler")
		if (!readdirSync(codePackagePath).includes("node_modules")) {
			execSync("npm install", { cwd: codePackagePath })
		}

		this.#handlerRole = new iam.Role(this, "ObjectManagerRole", {
			managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole")],
			assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com")
		})
		this.#handlerRole.addToPolicy(new iam.PolicyStatement({
			actions: [
				"s3:ListBucket",
				"s3:PutObject",
				"s3:PutObjectAcl",
				"s3:DeleteObject"
			],
			resources: [this.bucketArn, `${this.bucketArn}/*`]
		}))

		this.addToResourcePolicy(new iam.PolicyStatement({
			principals: [new iam.StarPrincipal()],
			effect: iam.Effect.DENY,
			actions: ["s3:PutObject", "s3:DeleteObject"],
			resources: [`${this.bucketArn}/*`],
			conditions: {
				StringNotLike: {
					"aws:userId": `${this.#handlerRole.roleId}:*`
				}
			}
		}))

		const handler = new lambda.Function(this, "ObjectManagerFunction", {
			runtime: lambda.Runtime.NODEJS_24_X,
			role: this.#handlerRole,
			code: lambda.Code.fromAsset(codePackagePath),
			handler: "index.handler",
			timeout: cdk.Duration.seconds(900),
			ephemeralStorageSize: cdk.Size.mebibytes(10240),
			logGroup: props.objectManagerLogGroup
		})

		new cdk.CustomResource(this, "Objects", {
			resourceType: "Custom::ManagedBucketObjects",
			serviceToken: handler.functionArn,
			properties: {
				props: cdk.Lazy.any({
					produce: () => ({
						bucketUrl: `s3://${this.bucketName}`,
						assets: this.#assets.map(asset => ({
							hash: asset.assetHash,
							s3BucketName: asset.s3BucketName,
							s3ObjectKey: asset.s3ObjectKey
						})),
						objects: this.#inlineBucketObjects,
						invalidationActions: this.#ObjectChangeActions
							.filter(action => (action as CloudFrontInvalidationObjectChangeAction).distribution !== undefined)
							.map(action => ({
								distributionId: (action as CloudFrontInvalidationObjectChangeAction).distribution.distributionId,
								waitForCompletion: (action as CloudFrontInvalidationObjectChangeAction).waitForCompletion
							}))
					})
				})
			}
		})
	}

	/**
	 * Add an object to the bucket based on a given key and body. Deploy-time values from the CDK
	 * like resource ARNs can be used here.
	 */
	addObject(props: {
		/** S3 object key for the object. */
		key: string,
		/** Content to be stored within the S3 object. */
		body: string
	}) {
		if (this.#inlineBucketObjects.find(x => x.key === props.key)) {
			throw new Error(`Cannot add object with duplicate key ${props.key} to ${this.node.id}.`)
		}
		this.#inlineBucketObjects.push(props)
	}

	/** Add objects to the bucket based on an [Asset](
	 * https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_s3_assets-readme.html).
	 * For example:
	 * 
	 * `bucket.addObjectsFromAsset({ asset: new Asset(this, "MyAsset", { path: "./my-local-files" }) })`
	 */
	addObjectsFromAsset(props: {
		/** The [Asset](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_s3_assets-readme.html
		 * ) to be added to the bucket. */
		asset: s3_assets.Asset
	}) {
		if (this.#assets.find(x => x.assetHash === props.asset.assetHash)) {
			throw new Error(`Cannot add objects from asset ${props.asset.assetHash} to ${this.node.id} twice.`)
		}
		this.#assets.push(props.asset)
		this.#handlerRole.addToPolicy(new iam.PolicyStatement({
			actions: ["s3:GetObject"],
			resources: [`${props.asset.bucket.bucketArn}/*`]
		}))
	}

	/** Add an action to be performed when objects in the bucket are changed. */
	addObjectChangeAction(action: ObjectChangeAction) {
		this.#ObjectChangeActions.push(action)
		if ((action as CloudFrontInvalidationObjectChangeAction).distribution !== undefined) {
			this.#handlerRole.addToPolicy(new iam.PolicyStatement({
				actions: ["cloudfront:CreateInvalidation", "cloudfront:GetInvalidation"],
				resources: [getDistributionArn((action as CloudFrontInvalidationObjectChangeAction).distribution)]
			}))
		}
	}
}

/** @hidden */
function getDistributionArn(distribution: cloudfront.IDistribution): string {
	return `arn:aws:cloudfront::${distribution.stack.account}:distribution/${distribution.distributionId}`
}
