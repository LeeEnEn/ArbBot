import request from 'graphql-request';
import ethers from 'ethers'
import dotenv from 'dotenv';
import HashMap from 'hashmap';
import fs from 'fs'

export default class GraphQuery {
    #uniswapPools = new HashMap()
    #apiKey
    #hopCount
    #startToken
    
    ethContract
    quoterContract

    constructor() {
        dotenv.config()
        this.#hopCount = process.env.HOP_COUNT
        this.#startToken = process.env.START_TOKEN
        this.#apiKey = process.env.GRAPH_API_KEY

        this.quoterContract = new ethers.Contract(
            '0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6',
            JSON.parse(
                fs.readFileSync('node_modules/@uniswap/v3-periphery/artifacts/contracts/lens/Quoter.sol/Quoter.json', 'utf-8')
            )["abi"],
            new ethers.providers.JsonRpcProvider(process.env.RPC)
        )
        this.ethContract = new ethers.Contract(
            '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
            JSON.parse(
                fs.readFileSync('src/abi.json', 'utf-8')
            ),
            new ethers.providers.JsonRpcProvider(process.env.RPC)
        )
    }

    /**
     * 
     * @returns A hashmap that contains all token pairs
     */
    async #initUniswapPools(errorCount=1) {
        const size = 100
        const endpoint = 'https://gateway-arbitrum.network.thegraph.com/api/'
            + this.#apiKey
            + '/subgraphs/id/FQ6JYszEKApsBpAmiHesRsd9Ygc6mzmpNRANeVQFYoVX';

        if (errorCount == 4) {
            console.log("Failed to fetch data! Exiting program.")
            process.exit()
        }
        if (errorCount >= 2) {
            console.log("Attempting to fetch data again...", errorCount, "of 3 attempts")
            this.#uniswapPools = new HashMap()
        } else {
            console.log("Fetching data from TheGraph...")
        }

        for (let i = 0; i < 5; i++) {
            const query = `
                {
                    liquidityPools(first:` + size * (i + 1) + `, 
                                orderBy: cumulativeSwapCount,
                                orderDirection: desc,
                                skip:` + size * i + `)
                    {
                        id
                        fees {
                            feePercentage
                        }
                        inputTokens {
                            id
                            name
                            symbol
                            decimals
                        }
                    }
                }`
            try {
                const data = await request(endpoint, query);
                await this.#processData(data)
            } catch (error) {
                console.log('Error fetching data!');
                console.log(error)
                await this.#initUniswapPools(++errorCount)
            }
        }
        console.log("Data sucessfully fetched!")
    }

    /**
     * Builds a hashmap that contains token details and 
     * corresponding token pairs and fee for a particular pool.
     * @param {HashMap} data - Liquidity pools retrieved from TheGraph 
     */
    async #processData(data) {
        let poolList = data["liquidityPools"]

        for (let i = 0; i < poolList.length; i++) {
            let pool = poolList[i]
            let poolId = pool["id"]
            let fee = (pool["fees"][1]["feePercentage"] * 10000).toString()
            let token0 = pool["inputTokens"][0]
            let token1 = pool["inputTokens"][1]

            if (await this.#poolMeetsRequirements(token0, token1, fee, poolId)) {
                if (!this.#uniswapPools.has(token0["id"])) {
                    this.#createTokenDetails(token0)
                }
    
                if (!this.#uniswapPools.has(token1["id"])) {
                    this.#createTokenDetails(token1)
                }
    
                await this.#updateTokenPairs(token0, token1, fee)
                await this.#updateTokenPairs(token1, token0, fee)
            }
        }
    }

    /**
     * Adds basic details of the token
     * @param {string} token - The token to be added into the hashmap
     */
    #createTokenDetails(token) {
        let map = new HashMap()
        let details = new HashMap()

        details.set("decimals", token["decimals"])
        details.set("identifier", token["name"] + "/" + token["symbol"])

        map.set("tokenDetails", details)
        map.set("tokenPairs", new HashMap())

        this.#uniswapPools.set(token["id"], map)
    }

    /**
     * Add token pairing details
     * @param {string} token0 - First token
     * @param {string} token1 - Second token
     * @param {string} fee - Liquidity pool's fee
     */
    async #updateTokenPairs(token0, token1, fee) {
        let tokenPairs = this.#uniswapPools.get(token0["id"]).get("tokenPairs")
        if (!tokenPairs.has(token1["id"])) {
            tokenPairs.set(token1["id"], [])
        }
        let feeList = tokenPairs.get(token1["id"])
        if (!feeList.includes(fee)) {
            feeList.push(fee)
        }
    }

    async #poolMeetsRequirements(token0, token1, fee, poolId) {
        try {
            await this.quoterContract.callStatic.quoteExactInput(
                ethers.utils.solidityPack(
                    ["address", "uint24", "address"],
                    [token0["id"], fee, token1["id"]]
                ),
                ethers.utils.parseUnits("1", "18"),
            )

            if (token0["id"] == this.#startToken || token1["id"] == this.#startToken) {
                if (ethers.utils.formatEther(await this.ethContract.balanceOf(poolId)) < 1) {
                    return false
                }
            }
            
            return true
        } catch (error) {
            return false
        }
    }

    /**
     * 
     * @returns An array which contains all possible paths of default hop length
     */
    async getPaths() {
        await this.#initUniswapPools()

        if (this.#uniswapPools != null) {
            let tokenPath = [this.#startToken]
            return this.#getArbPathHelper(this.#hopCount, tokenPath).flat(this.#hopCount - 1)
        }
        return []
    }

    /**
     * 
     * @param {int} hopCount - Upper limit on the number of hops
     * @returns An array which contains all possible paths of 1 to N hop lengths
     */
    async getMultipleHopPaths(hopCount = this.#hopCount) {
        console.time("Time to fetch data")
        await this.#initUniswapPools()
		
        if (this.#uniswapPools != null) { 
            console.log("Generating permutations...")
            let counter = 1
            let tokenPath = [this.#startToken]
            let result = []

            while (counter < hopCount) {
                let path = this.#getArbPathHelper(counter, tokenPath).flat(counter - 1)
                if (path.length != 0) {
                    result.push(path)
                }
                counter += 1
            }
            console.log("Generated successfully! Total number of token hops:", (result.flat(1)).length)
            return result.flat(1)
        }
        console.timeEnd("Time to fetch data")
        return []
    }

    /**
     * 
     * @param {int} hopCount - Number of pool swaps
     * @param {array[string]} tokenPath - The list of different tokens and their pool 
     *                                    fee in which the token is being swapped to 
     * @returns An array which contains all possible paths
     */
    #getArbPathHelper(hopCount, tokenPath) {
        let prevHopToken = tokenPath[tokenPath.length - 1]
        let paths = []

        // Base case
        if (hopCount == 1) {
            // There is a hop to start token
            if (this.#uniswapPools.get(prevHopToken).get("tokenPairs").has(tokenPath[0])) {
                let index = tokenPath.indexOf(prevHopToken)
                let copyFeeList = structuredClone(this.#uniswapPools.get(prevHopToken).get("tokenPairs").get(tokenPath[0]))

                while (index != -1) {
                    // Remove previously used fee from list
                    if (copyFeeList.includes(tokenPath[index - 1])) {
                        copyFeeList.splice(copyFeeList.indexOf(tokenPath[index - 1]), 1)
                    }
                    index = tokenPath.indexOf(prevHopToken, index + 1)
                }

                copyFeeList.forEach(fee => {
                    let finalPath = structuredClone(tokenPath)
                    finalPath.push(fee, tokenPath[0])
                    paths.push(finalPath)
                })
            }
            return paths
        }

        this.#uniswapPools.get(prevHopToken).get("tokenPairs").forEach((feeList, token1CA) => {
            // Only take hops to non-starting token
            if (token1CA != tokenPath[0]) {
                // Find token1 in path
                let index = tokenPath.indexOf(token1CA)
                let copyFeeList = structuredClone(feeList)

                while (index != -1) {
                    // Remove previously used fee from list
                    if (tokenPath[index - 2] == prevHopToken && copyFeeList.includes(tokenPath[index - 1])) {
                        let i = copyFeeList.indexOf(tokenPath[index - 1])
                        copyFeeList.splice(i, 1)
                    }
                    index = tokenPath.indexOf(token1CA, index + 1)
                }
                // Recursively find paths
                copyFeeList.forEach(fee => {
                    let nextTokenPath = structuredClone(tokenPath)
                    nextTokenPath.push(fee, token1CA)

                    let result = this.#getArbPathHelper(hopCount - 1, nextTokenPath)
                    if (result.length != 0) {
                        paths.push(result)
                    }
                })
            }
        })
        return paths
    }

    /**
     * 
     * @param {int} hops - Number of iterations 
     * @returns An array with "address" "uint24" "address" pairs 
     */
    getPathArray(hops) {
        let pathArray = ["address"]
        while (hops > 0) {
            pathArray.push("uint24", "address")
            hops -= 1
        }
        return pathArray
    }

    /**
     * 
     * @param {array[string]} paths 
     * @returns An array using with token identifiers if paths have been built
     */
    getReadablePaths(paths) {
        let readablePath = []

        if (paths == undefined) {
            return readablePath
        }

        paths.forEach((path) => {
            let rPath = []

            path.forEach((token) => {
                if (this.#uniswapPools.get(token) != undefined) {
                    rPath.push(this.#uniswapPools.get(token).get("tokenDetails").get("identifier"))
                }
            })
            readablePath.push(rPath)
        })
        return readablePath
    }
}
