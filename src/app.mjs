import GraphQuery from './graphQuery.mjs'
import FileRW from './fileRW.js'

import fs from 'fs'
import ethers, { providers } from 'ethers'
import dotenv from 'dotenv'

async function main() {
    dotenv.config()

    const provider = new ethers.providers.JsonRpcProvider(process.env.RPC)
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY).connect(provider)
    const QUOTER = '0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6'
    const QuoterABI = JSON.parse(
        fs.readFileSync('/@uniswap/v3-periphery/artifacts/contracts/lens/Quoter.sol/Quoter.json', 'utf-8')
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
	
    let contents = fileRW.getContents()
	let paths = contents[0]
    let readablePath = contents[1]    

    const amountIn = process.env.AMOUNT_IN
	
	while (true) {
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
					) * (0.9975 ** (readablePath[i].length)) * 0.99
			
				if (quoteValue > amountIn) {
					console.log(readablePath[i], quoteValue)
					swap(wallet, pathArray, paths[i], amountIn, quoteValue)
				}
				if (i % 500 == 0) {
					console.log("Still searching...", i)
				}
			} catch(err) {

			}
		}
	}
};

async function swap(wallet, pathArray, path, amountIn, expectedAmount) {
    const SWAP_ROUTER = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45'
    const UniswapRouterABI = JSON.parse(
        fs.readFileSync('src/SwapRouterABI.json')
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
