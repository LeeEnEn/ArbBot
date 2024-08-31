import request from 'graphql-request';
import ethers from 'ethers'
import dotenv from 'dotenv';
import HashMap from 'hashmap';

export default class GraphQuery {
    #uniswapPools = new HashMap()
    
    #ERC20ABI
    #HOP_COUNT
    #PROVIDER
    #QUOTER_CONTRACT
    #START_TOKEN
    
    constructor(provider, quoterContract, ERC20ABI) {
        dotenv.config()
        this.#HOP_COUNT = process.env.HOP_COUNT
        this.#START_TOKEN = process.env.START_TOKEN
        this.#PROVIDER = provider
        this.#QUOTER_CONTRACT = quoterContract
        this.#ERC20ABI = ERC20ABI
    }

    /**
     * 
     * @param {Number} errorCount - Number of errors that has occured
     * @param {String} endpoint   - TheGraph end point 
     * @param {Function} queryFn  - Function that returns a query
     */
    async #initUniswapPools(endpoint, queryFn, errorCount=0) {
        const size = 10
        const iteration = 3

        if (errorCount == 3) {
            console.log("Failed to fetch data! Exiting program.")
            process.exit()
        }
        if (errorCount >= 1) {
            console.log("Attempting to fetch data again...", errorCount + 1, "of 3 attempts")
            this.#uniswapPools = new HashMap()
        } else {
            console.log("Fetching data from TheGraph...")
        }

        for (let i = 0; i < iteration; i++) {
            console.log("Querying percentage:", Math.round(i * 100 / iteration, 2))
            const query = queryFn(i, size)
            try {
                const data = await request(endpoint, query);
                await this.#processData(data)
            } catch (error) {
                console.log('Error fetching data!');
                console.log(error)
                await this.#initUniswapPools(endpoint, queryFn, ++errorCount)
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
                await Promise.all([this.#updateTokenPairs(token0, token1, fee), this.#updateTokenPairs(token1, token0, fee)])
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
     * @param {string} fee    - Liquidity pool's fee
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

    /**
     * 
     * @param {HashMap} token0 - Details of token0
     * @param {HashMap} token1 - Details of token1
     * @param {string} fee     - Liquidity pool's fee
     * @param {string} poolId  - Liquidity pool's contract address
     * @returns A boolean stating if liquidity pool found matches requirements
     */
    async #poolMeetsRequirements(token0, token1, fee, poolId) {
        
        try {
            // If pool exist
            await this.#QUOTER_CONTRACT.callStatic.quoteExactInput(
                ethers.utils.solidityPack(
                    ["address", "uint24", "address"],
                    [token0["id"], fee, token1["id"]]
                ),
                ethers.utils.parseUnits("1", "18"),
            )

            // Liquidity of pool > 1000
            const token0Promise = new ethers.Contract(
                token0["id"],
                this.#ERC20ABI,
                this.#PROVIDER
            ).balanceOf(poolId)

            const token1Promise = new ethers.Contract(
                token1["id"],
                this.#ERC20ABI,
                this.#PROVIDER
            ).balanceOf(poolId)

            const [v0, v1] = await Promise.all([token0Promise, token1Promise])
            const valueOfToken0InPool = ethers.utils.formatUnits(v0, token0["decimals"]) * token0["lastPriceUSD"]
            const valueOfToken1InPool = ethers.utils.formatUnits(v1, token1["decimals"]) * token1["lastPriceUSD"]

            if (valueOfToken0InPool + valueOfToken1InPool < 1000) {                
                return false
            }
            return true
        } catch (error) {
            return false
        }
    }

    /**
     * 
     * @param {int} hopCount - Upper limit on the number of hops
     * @returns An array which contains all possible paths of 1 to N hop lengths
     */
    async getMultipleHopPaths(graphEndPoint, queryFn, hopCount = this.#HOP_COUNT) {
        console.time("Time to fetch data")
        await this.#initUniswapPools(graphEndPoint, queryFn)
		
        if (this.#uniswapPools != null) { 
            console.log("Generating permutations...")
            let counter = 1
            let tokenPath = [this.#START_TOKEN]
            let result = []

            while (counter < hopCount) {
                let path = this.#getArbPathHelper(counter, tokenPath).flat(counter - 1)
                if (path.length != 0) {
                    result.push(path)
                }
                counter += 1
            }
            console.log("Generated successfully! Total number of token hops:", (result.flat(1)).length)
            console.timeEnd("Time to fetch data")
            return result.flat(1)
        }
        console.timeEnd("Time to fetch data")
        return []
    }

    /**
     * 
     * @param {int} hopCount            - Number of pool swaps
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
     * @param {array[string]} paths - An array consisting of paths
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
