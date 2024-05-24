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
	deploymentLogGroup?: logs.ILogGroup
}

type InlineBucketObject = {
	key: string
	content: string
}

type CloudFrontDistributionInvalidationDeploymentActionProps = {
	distribution: cloudfront.Distribution,
	waitForCompletion?: boolean
}

export class DeploymentAction {
	#classname = "DeploymentAction"
	static cloudFrontDistributionInvalidation(props: CloudFrontDistributionInvalidationDeploymentActionProps) {
		return new CloudFrontDistributionInvalidationDeploymentAction(props)
	}
}

class CloudFrontDistributionInvalidationDeploymentAction extends DeploymentAction {
	distribution: cloudfront.Distribution
	waitForCompletion?: boolean
	constructor(props: CloudFrontDistributionInvalidationDeploymentActionProps) {
		super()
		this.distribution = props.distribution
		this.waitForCompletion = props.waitForCompletion
	}
}

export class ManagedObjectsBucket extends s3.Bucket {
	#inlineBucketObjects: Array<InlineBucketObject>
	#assets: Array<s3_assets.Asset>
	#deploymentActions: Array<DeploymentAction>
	#handlerRole: iam.Role
	constructor(scope: Construct, id: string, props: ManagedObjectsBucketProps) {
		super(scope, id, {
			removalPolicy: cdk.RemovalPolicy.DESTROY,
			...props
		})
		this.#inlineBucketObjects = []
		this.#assets = []
		this.#deploymentActions = []

		const codePackagePath = path.join(__dirname, "..", "..", "..", "handler")
		if (!readdirSync(codePackagePath).includes("node_modules")) {
			execSync("npm install", { cwd: codePackagePath })
		}

		this.#handlerRole = new iam.Role(this, "ObjectsManagerRole", {
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

		const handler = new lambda.Function(this, "ObjectsManager", {
			runtime: lambda.Runtime.NODEJS_20_X,
			role: this.#handlerRole,
			code: lambda.Code.fromAsset(codePackagePath),
			handler: "index.handler",
			timeout: cdk.Duration.seconds(900),
			ephemeralStorageSize: cdk.Size.mebibytes(10240),
			logGroup: props.deploymentLogGroup
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
						invalidationActions: this.#deploymentActions
							.filter(action => (action as CloudFrontDistributionInvalidationDeploymentAction).distribution !== undefined)
							.map(action => ({
								distributionId: (action as CloudFrontDistributionInvalidationDeploymentAction).distribution.distributionId,
								waitForCompletion: (action as CloudFrontDistributionInvalidationDeploymentAction).waitForCompletion
							}))
					})
				})
			}
		})
	}

	addObject(props: { key: string, content: string }) {
		if (this.#inlineBucketObjects.find(x => x.key === props.key)) {
			throw new Error(`Cannot add object with duplicate key ${props.key} to ${this.node.id}.`)
		}
		this.#inlineBucketObjects.push(props)
	}

	addObjectsFromAsset(props: { asset: s3_assets.Asset }) {
		if (this.#assets.find(x => x.assetHash === props.asset.assetHash)) {
			throw new Error(`Cannot add objects from asset ${props.asset.assetHash} to ${this.node.id} twice.`)
		}
		this.#assets.push(props.asset)
		this.#handlerRole.addToPolicy(new iam.PolicyStatement({
			actions: ["s3:GetObject"],
			resources: [`${props.asset.bucket.bucketArn}/*`]
		}))
	}

	addDeploymentAction(action: DeploymentAction) {
		this.#deploymentActions.push(action)
		if ((action as CloudFrontDistributionInvalidationDeploymentAction).distribution !== undefined) {
			this.#handlerRole.addToPolicy(new iam.PolicyStatement({
				actions: ["cloudfront:CreateInvalidation", "cloudfront:GetInvalidation"],
				resources: [getDistributionArn((action as CloudFrontDistributionInvalidationDeploymentAction).distribution)]
			}))
		}
	}
}

function getDistributionArn(distribution: cloudfront.IDistribution): string {
	return `arn:aws:cloudfront::${distribution.stack.account}:distribution/${distribution.distributionId}`
}