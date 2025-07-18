import fs from "fs"
import path from "path"
import AdmZip from "adm-zip"
import mime from "mime-types"
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3"
import { S3SyncClient } from "s3-sync-client"
import { CloudFrontClient, CreateInvalidationCommand, GetInvalidationCommand } from "@aws-sdk/client-cloudfront"
import { glob } from "glob"

export async function handler(event) {
	try {
		console.log(JSON.stringify({ ...event, ResponseURL: "REDACTED" }))
		if (process.env.SKIP === "true") {
			console.log(`Skipping due to environment variable SKIP: ${JSON.stringify(process.env.SKIP)}.`)
		} else {
			await deploy(event)
		}
		await sendResponse("SUCCESS", undefined, event)
	} catch (error) {
		try {
			await sendResponse("FAILED", error.message, event)
		} catch (error) {
			console.error("Failed to send FAILED response", error)
		}
		throw error
	}
}

async function sendResponse(status, reason, event) {
	console.log(`Sending ${status}...`)
	const res = await fetch(event.ResponseURL, {
		method: "PUT",
		body: JSON.stringify({
			Status: status,
			Reason: reason,
			PhysicalResourceId: event.LogicalResourceId,
			StackId: event.StackId,
			RequestId: event.RequestId,
			ResourceType: event.ResourceType,
			LogicalResourceId: event.LogicalResourceId
		})
	})
	if (res.status >= 400) throw new Error(`Received ${res.status} ${res.statusText}`)
}

async function deploy(event) {
	const s3Client = new S3Client({})
	const s3SyncClient = new S3SyncClient({ client: s3Client })
	const cloudFrontClient = new CloudFrontClient({})

	const props = event.ResourceProperties.props
	const workArea = `/tmp/${event.RequestId}`
	const finalPath = path.join(workArea, "final")

	console.log(`Setting up work area ${workArea}...`)
	await fs.promises.rm(workArea, { recursive: true, force: true })
	await fs.promises.mkdir(finalPath, { recursive: true })

	if (event.RequestType !== "Delete") {
		const files = (await Promise.all([
			...props.assets.map(async asset => {
				const localAssetPath = path.join(workArea, asset.hash)
				await fs.promises.mkdir(localAssetPath, { recursive: true })
				console.log(`Getting object ${asset.s3BucketName}/${asset.s3ObjectKey} to ${path.join(localAssetPath, asset.s3ObjectKey)}...`)
				const zipBody = (await s3Client.send(new GetObjectCommand({
					Bucket: asset.s3BucketName,
					Key: asset.s3ObjectKey
				}))).Body
				await fs.promises.writeFile(path.join(localAssetPath, asset.s3ObjectKey), zipBody)

				console.log(`Unzipping ${path.join(localAssetPath, asset.s3ObjectKey)} to ${path.join(localAssetPath, "unzipped")}...`)
				const admZip = new AdmZip(path.join(localAssetPath, asset.s3ObjectKey))
				admZip.extractAllTo(path.join(localAssetPath, "unzipped"))
				await fs.promises.rm(path.join(localAssetPath, asset.s3ObjectKey), { recursive: true })
				const files = await glob("**/*", { cwd: path.join(localAssetPath, "unzipped"), nodir: true })

				console.log(`Moving ${path.join(localAssetPath, "unzipped")} to ${finalPath}...`)
				await fs.promises.cp(path.join(localAssetPath, "unzipped"), finalPath, { recursive: true })
				await fs.promises.rm(path.join(localAssetPath), { recursive: true })
				return files
			}),
			...props.objects.map(async object => {
				console.log(`Adding object ${object.key} to ${finalPath}...`)
				await fs.promises.mkdir(path.join(finalPath, object.key, ".."), { recursive: true })
				await fs.promises.writeFile(path.join(finalPath, object.key), object.body)
				return [object.key]
			})
		])).flat()
		const duplicateFiles = Array.from(getFrequencies(files).entries())
			.filter(entry => entry[1] > 1)
			.map(entry => entry[0])
		if (duplicateFiles.length > 0) {
			throw new Error(`Duplicate object keys: ${JSON.stringify(duplicateFiles)}`)
		}
	}

	console.log(`Syncing from ${finalPath} to ${props.bucketUrl}...`)
	await s3SyncClient.sync(finalPath, props.bucketUrl, {
		del: true,
		commandInput: (input) => ({
			ContentType: mime.lookup(input.Key) || "text/html",
		})
	})
	await fs.promises.rm(workArea, { recursive: true })

	await Promise.all(props.invalidationActions.map(async invalidationAction => {
		console.log(`Creating cloudfront invalidation for distribution ${invalidationAction.distributionId}...`)
		const createRes = await cloudFrontClient.send(new CreateInvalidationCommand({
			DistributionId: invalidationAction.distributionId,
			InvalidationBatch: {
				Paths: {
					Quantity: 1,
					Items: ["/*"],
				},
				CallerReference: Date.now().toString(),
			}
		}))
		if (invalidationAction.waitForCompletion) {
			console.log(`Waiting for invalidation ${createRes.Invalidation.Id} to complete...`)
			let status = createRes.Invalidation.Status
			while (status !== "Completed") {
				await sleep(1000)
				try {
					const res = await cloudFrontClient.send(new GetInvalidationCommand({
						DistributionId: invalidationAction.distributionId,
						Id: createRes.Invalidation.Id
					}))
					status = res.Invalidation.Status
				} catch (error) {
					if (error.name === "NoSuchInvalidation") status = undefined
					else throw error
				}
			}
		}
	}))
}

function getFrequencies(list) {
	const map = new Map()
	for (const item of list) {
		const existingCount = map.get(item) !== undefined ? map.get(item) : 0
		map.set(item, existingCount + 1 )
	}
	return map
}

async function sleep(ms) {
	return new Promise((resolve) => setTimeout(() => resolve(), ms))
}