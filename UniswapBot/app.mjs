import GraphQuery from '../common/graphQuery.mjs'
import FileRW from '../common/fileRW.js'

import { isMainThread, workerData, Worker } from 'worker_threads'
import { fileURLToPath } from 'url';
import fs from 'fs'
import ethers from 'ethers'
import dotenv from 'dotenv'

/**
 * This function first tries to obtain all possible swap paths found in Uniswap Arbitrum L2.
 * Thereafter, spawning mulitple worker threads to loop through each path to find the one that
 * matches 
 */
async function main() {
    dotenv.config()

    const PROVIDER = new ethers.providers.JsonRpcProvider(process.env.RPC)
    const WALLET = new ethers.Wallet(process.env.PRIVATE_KEY).connect(PROVIDER)
    const QUOTER = '0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6'
    const QUOTER_ABI = JSON.parse(fs.readFileSync('../node_modules/@uniswap/v3-periphery/artifacts/contracts/lens/Quoter.sol/Quoter.json', 'utf-8'))["abi"]
    const QUOTER_CONTRACT = new ethers.Contract(
        QUOTER,
        QUOTER_ABI,
        PROVIDER
    )
    const FILEPATH = process.env.UNISWAP_BOT_FILE_PATH

    let gq = new GraphQuery(PROVIDER, QUOTER_CONTRACT)
    let fileRW = new FileRW(FILEPATH)

	if (!fileRW.isFileExist()) {
        let paths = await gq.generatePermutations(getGraphEndPoint(), getQueryFn)
		let readablePath = gq.getReadablePaths(paths)
		fileRW.writeContents(paths, readablePath, true)
	}

    const AMOUNT_IN = process.env.AMOUNT_IN
    const WORKER_COUNT = process.env.WORKER_COUNT
    const THRESHOLD = process.env.THRESHOLD
    const SLIPPAGE = process.env.SLIPPAGE

    if (isMainThread) {
        let contents = fileRW.getContents()
	    let paths = contents[0]
        let readablePath = contents[1]

        const __filename = fileURLToPath(import.meta.url)
        const DATA_PER_WORKER = Math.ceil(paths.length / WORKER_COUNT)

        for (let i = 0; i < WORKER_COUNT; i++) {
            new Worker(__filename, { 
                workerData: 
                    [i, 
                    paths.slice(i * DATA_PER_WORKER, (i + 1) * DATA_PER_WORKER), 
                    readablePath.slice(i * DATA_PER_WORKER, (i + 1) * DATA_PER_WORKER)]
                }
            )
        }
    } else {
        let workerId = workerData[0]
        let paths = workerData[1]
        let readablePath = workerData[2]

        console.log(`Starting worker ${workerId} with ${paths.length} paths...`)

        while (true) {
			console.time(`Time taken ${workerId}`)
            for (let i = 0; i < paths.length; i++) {
                try {
                    const pathArray = gq.getPathArray(readablePath[i].length - 1)
                    const quoteValue = ethers.utils.formatUnits(
                        await QUOTER_CONTRACT.callStatic.quoteExactInput(
                            ethers.utils.solidityPack(
                                    pathArray, 
                                    paths[i]            
                                ),
                                ethers.utils.parseUnits(AMOUNT_IN.toString(), "18"),
                            ), 18
                        ) * (0.9975 ** (readablePath[i].length - 1)) * (1 - SLIPPAGE)

                    if (quoteValue > AMOUNT_IN * (1 + parseFloat(THRESHOLD))) {
                        console.log(`Initiating swap ${readablePath[i]}. Expected swap value: ${quoteValue}`)
                        swap(WALLET, paths[i], AMOUNT_IN, quoteValue)
                    }
                } catch(err) {
                    console.log(err.code)
                }
            }
			console.timeEnd(`Time taken ${workerId}`)
        }
    }	
};

/**
 * 
 * @param {ethers.Wallet} wallet  - User wallet 
 * @param {array[string]} path    - Specified path
 * @param {Number} amountIn       - Amount used as input
 * @param {Number} expectedAmount - Amount used as output
 */
async function swap(wallet, path, amountIn, expectedAmount) {
    const SWAP_ROUTER = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45'
    const UNISWAP_ROUTER_ABI = JSON.parse(fs.readFileSync('UniswapBot/SwapRouterABI.json', 'utf-8'))
    const SWAP_CONTRACT = new ethers.Contract(
        SWAP_ROUTER,
        UNISWAP_ROUTER_ABI,
        wallet
    )
	
    const HEX_DATA = getHexPath(path)
    const DEADLINE = Math.floor(Date.now() / 1000) + 60 * 1
    const WALLET_ADDRESS = wallet.getWalletAddress()
	
	amountIn = ethers.utils.parseUnits(amountIn.toString(), 18)
	
    try {
        const tx = await SWAP_CONTRACT.exactInput(
			{
				path: HEX_DATA,
				recipient: WALLET_ADDRESS,
				deadline: DEADLINE,
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

/**
 * 
 * @param {array[string]} path - Specified path 
 * @returns A string with addresses and fees in hexadecimal
 */
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

function getGraphEndPoint() {
    return `https://gateway-arbitrum.network.thegraph.com/api/${process.env.GRAPH_API_KEY}` +
        `/subgraphs/id/FQ6JYszEKApsBpAmiHesRsd9Ygc6mzmpNRANeVQFYoVX`
}

function getQueryFn(iteration, size) {
    return `
    {
        liquidityPools(
            first: ${size * (iteration + 1)}, 
            orderBy: cumulativeSwapCount,
            orderDirection: desc,
            skip: ${size * iteration}
        ){
        id
        fees {
            feePercentage
        }
        inputTokens {
            id
            name
            symbol
            decimals
            lastPriceUSD
            }
        }
    }`
}

main()
