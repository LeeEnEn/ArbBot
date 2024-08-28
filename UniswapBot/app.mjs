import GraphQuery from './graphQuery.mjs'
import FileRW from './fileRW.js'

import { isMainThread, workerData, Worker } from 'worker_threads'
import { fileURLToPath } from 'url';
import fs from 'fs'
import ethers from 'ethers'
import dotenv from 'dotenv'

async function main() {
    dotenv.config()

    const provider = new ethers.providers.JsonRpcProvider(process.env.RPC)
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY).connect(provider)
    const QUOTER = '0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6'
    const QuoterABI = JSON.parse(
        fs.readFileSync('../node_modules/@uniswap/v3-periphery/artifacts/contracts/lens/Quoter.sol/Quoter.json', 'utf-8')
    )["abi"]
    const quoterContract = new ethers.Contract(
        QUOTER,
        QuoterABI,
        new ethers.providers.JsonRpcProvider(process.env.RPC)
    )

    let gq = new GraphQuery()
    let fileRW = new FileRW()

	if (!fileRW.isFileExist()) {
        let paths = await gq.getMultipleHopPaths()
		let readablePath = gq.getReadablePaths(paths)
		fileRW.writeContents(paths, readablePath, true)
	}

    const amountIn = process.env.AMOUNT_IN
    const workerCount = process.env.WORKER_COUNT
    const threshold = process.env.THRESHOLD

    if (isMainThread) {
        let contents = fileRW.getContents()
	    let paths = contents[0]
        let readablePath = contents[1]

        const __filename = fileURLToPath(import.meta.url)
        const amount = Math.ceil(paths.length / workerCount)

        for (let i = 0; i < workerCount; i++) {
            new Worker(__filename, { 
                workerData: 
                    [i, 
                    paths.slice(i * amount, (i + 1) * amount), 
                    readablePath.slice(i * amount, (i + 1) * amount)]
                }
            )
        }
    } else {
        let workerId = workerData[0]
        let paths = workerData[1]
        let readablePath = workerData[2]

        console.log("Starting worker", workerId, "with", paths.length, "paths...")

        while (true) {
			console.time("Time taken" + workerId)
            for (let i = 0; i < paths.length; i++) {
                try {
                    const pathArray = gq.getPathArray(readablePath[i].length - 1)
                    const quoteValue = ethers.utils.formatUnits(
                        await quoterContract.callStatic.quoteExactInput(
                            ethers.utils.solidityPack(
                                    pathArray, 
                                    paths[i]            
                                ),
                                ethers.utils.parseUnits(amountIn.toString(), "18"),
                            ), 18
                        ) * (0.9975 ** (readablePath[i].length)) * (1 - threshold)
                
                    if (quoteValue > amountIn) {
                        console.log(readablePath[i], quoteValue)
                        swap(wallet, paths[i], amountIn, quoteValue)
                    }
                } catch(err) {
                    console.log(err)
                    process.exit()
                }
            }
			console.timeEnd("Time taken" + workerId)
        }
    }	
};

async function swap(wallet, path, amountIn, expectedAmount) {
    const SWAP_ROUTER = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45'
    const UniswapRouterABI = JSON.parse(
        fs.readFileSync('UniswapBot/SwapRouterABI.json')
    )
    let swapContract = new ethers.Contract(
        SWAP_ROUTER,
        UniswapRouterABI,
        wallet
    )
	
    const data = getHexPath(path)
    const deadline = Math.floor(Date.now() / 1000) + 60 * 1
    const recipient = wallet.getWalletAddress()
	
	amountIn = ethers.utils.parseUnits(amountIn.toString(), 18)
	
    try {
        const tx = await swapContract.exactInput(
			{
				path: data,
				recipient: recipient,
				deadline: deadline,
				amountIn: amountIn,
				amountOutMinimum: parseInt(expectedAmount * 10 ** 18),
			},
			{
				maxPriorityFeePerGas: ethers.utils.hexlify(0),
				maxFeePerGas: ethers.utils.hexlify(10000000),
				gasLimit: ethers.utils.hexlify(1000000),
				value: amountIn
			}
        )
        console.log(await tx.wait())        
    } catch (error) {
        console.log(error)
    }
}

function getHexPath(path) {
	let result = '0x'
	
	for (let i = 0; i < path.length; i++) {
		let value = path[i]
		
		if (i % 2 == 1) {
			value = ethers.utils.hexZeroPad(ethers.utils.hexlify(parseInt(value)), 3)
		}
		result += value.slice(2)
	}
	return result
}

main();
