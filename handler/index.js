import fs from "fs"
import path from "path"
import unzipper from "unzipper"
import mime from "mime-types"
import { S3Client } from "@aws-sdk/client-s3"
import { S3SyncClient } from  "s3-sync-client"
import { CloudFrontClient, CreateInvalidationCommand } from "@aws-sdk/client-cloudfront"

export async function handler(event) {
	try {
		console.log(JSON.stringify({ ...event, ResponseURL: "REDACTED" }))
		await deploy(event)
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
	const s3SyncClient = new S3SyncClient({ client: new S3Client({}) })
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
				console.log(`Syncing from ${asset.s3ObjectUrl} to ${localAssetPath}...`)
				await s3SyncClient.sync(asset.s3ObjectUrl, localAssetPath)
	
				console.log(`Unzipping ${path.join(localAssetPath, asset.s3ObjectKey)} to ${path.join(localAssetPath, "unzipped")}...`)
				await unzip(path.join(localAssetPath, asset.s3ObjectKey), path.join(localAssetPath, "unzipped"))
	
				console.log(`Copying ${path.join(localAssetPath, "unzipped")} to ${finalPath}...`)
				await fs.promises.cp(path.join(localAssetPath, "unzipped"), finalPath, { recursive: true })
				return await fs.promises.readdir(path.join(localAssetPath, "unzipped"), { recursive: true })
			}),
			...props.objects.map(async object => {
				console.log(`Adding object ${object.key} to ${finalPath}...`)
				await fs.promises.mkdir(path.join(finalPath, object.key, ".."), { recursive: true })
				await fs.promises.writeFile(path.join(finalPath, object.key), object.content)
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

	await Promise.all(props.distributionIds.map(async distributionId => {
		console.log(`Creating cloudfront invalidation for distribution ${distributionId}...`)
		await cloudFrontClient.send(new CreateInvalidationCommand({
			DistributionId: distributionId,
			InvalidationBatch: {
				Paths: {
					Quantity: 1,
					Items: ["/*"],
				},
				CallerReference: Date.now().toString(),
			}
		}))
	}))
}

async function unzip(source, destination) {
	return new Promise((resolve, reject) => {
		fs.createReadStream(source)
			.pipe(unzipper.Extract({ path: destination }))
			.on("close", () => resolve())
			.on("error", error => reject(error))
	})
}

function getFrequencies(list) {
	const map = new Map()
	for (const item of list) {
		const existingCount = map.get(item) !== undefined ? map.get(item) : 0
		map.set(item, existingCount + 1 )
	}
	return map
}