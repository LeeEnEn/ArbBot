import request from 'graphql-request';
import fs from 'fs'
import ethers, { Contract } from 'ethers'
import dotenv from 'dotenv'
import HashMap from 'hashmap';


class V2 {
    #ERC20ABI
    #ENDPOINT
    #FACTORY
    #ROUTER
    #PROVIDER
    #HOP_COUNT
    
    #swapPools = new HashMap()
    
    constructor(){
        dotenv.config()
        const CAMELOT_FACTORY_V2 = '0x6EcCab422D763aC031210895C81787E87B43A652'
        const CAMELOT_ROUTER_V2 = '0xc873fEcbd354f5A56E00E710B90EF4201db2448d'
        this.#PROVIDER = new ethers.providers.JsonRpcProvider(process.env.RPC)
        this.#HOP_COUNT = process.env.HOP_COUNT
        this.#ERC20ABI = JSON.parse(fs.readFileSync("common/ERC20ABI.json"), "utf-8")
        this.#ENDPOINT = `https://gateway.thegraph.com/api/${process.env.GRAPH_API_KEY}/subgraphs/id/8zagLSufxk5cVhzkzai3tyABwJh53zxn9tmUYJcJxijG`
        
        this.#FACTORY = new Contract(
            CAMELOT_FACTORY_V2,
            JSON.parse(fs.readFileSync("CamelotBot/FactoryV2ABI.json","utf-8")),
            this.#PROVIDER
        )
        this.#ROUTER = new Contract(
            CAMELOT_ROUTER_V2,
            JSON.parse(fs.readFileSync("CamelotBot/RouterV2ABI.json", "utf-8")),
            this.#PROVIDER
        )
    }

    async #initSwapPools() {
        let size = 100
        let iterations = 5

        const TIMESTAMP = this.#getTimestampForGraph()
        const ETH_PRICE = await this.#getCurrentEthPrice(TIMESTAMP)
        
        console.log("Fetching data from TheGraph...")
        console.time("Time to fetch data")
        for (let i = 0; i < iterations; i++) {
            const QUERY = `
            {
                pairs(first: ${size}, orderBy: txCount, orderDirection: desc, skip: ${i * size}) {
                    id
                    token0 {
                        decimals
                        id
                        name
                        symbol
                    }
                    token1 {
                        decimals
                        id
                        name
                        symbol
                    }
                }
            }`

            const DATA = (await request(this.#ENDPOINT, QUERY))["pairs"]
            await this.#processData(DATA, ETH_PRICE) 

        }
        console.log("Successfully fetched data!")
        console.timeEnd("Time to fetch data")
    }

    async #processData(data, ethPrice) {
        for (let i = 0; i < data.length; i++) {
            let poolId = data[i]["id"]
            let token0 = data[i]["token0"]
            let token1 = data[i]["token1"]

            if (await this.#poolMeetsRequirements(token0, token1, ethPrice, poolId)) {
                if (!this.#swapPools.has(token0["id"])) {
                    this.#createTokenDetails(token0)
                }
    
                if (!this.#swapPools.has(token1["id"])) {
                    this.#createTokenDetails(token1)
                }
                await Promise.all([this.#updateTokenPairs(token0, token1), this.#updateTokenPairs(token1, token0)])
            }
        }
    }

    #getTimestampForGraph() {
        return Math.floor(Date.now() / 1000 / 24 / 3600)
    }

    async #getCurrentEthPrice(timestamp) {
        const QUERY = `
        {
            tokenDayData(id: "0x82af49447d8a07e3bd95bd0d56f35241523fbab1-${timestamp}") {
                priceUSD
            }
        }
        `
        const DATA = await request(this.#ENDPOINT, QUERY)
        return DATA["tokenDayData"]["priceUSD"]
    }

    async #poolMeetsRequirements(token0, token1, currentEthPrice, poolId) {
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
        const valueOfToken0InPool = ethers.utils.formatUnits(v0, token0["decimals"]) * token0["derivedETH"] * currentEthPrice
        const valueOfToken1InPool = ethers.utils.formatUnits(v1, token1["decimals"]) * token1["derivedETH"] * currentEthPrice

        if (valueOfToken0InPool + valueOfToken1InPool < 1000) {
            return false
        }
        return true
    }
    
    #createTokenDetails(token) {
        let map = new HashMap()
        let details = new HashMap()

        details.set("decimals", token["decimals"])
        details.set("identifier", token["name"] + "/" + token["symbol"])

        map.set("tokenDetails", details)
        map.set("tokenPairs", [])

        this.#swapPools.set(token["id"], map)
    }

    async #updateTokenPairs(token0, token1) {
        let tokenPairs = this.#swapPools.get(token0["id"]).get("tokenPairs")
        if (!tokenPairs.includes(token1["id"])) {
            tokenPairs.push(token1["id"])
        }
    }
    
    async generateMultiplePermutations(hopCount=this.#HOP_COUNT) {
        let result = []
        await this.#initSwapPools()
        console.log("Generating permutations...")

        let counter = 1
        while (counter < hopCount) {
            let path = this.#permutationHelper(counter, [process.env.START_TOKEN]).flat(counter - 1)
            if (path.length != 0) {
                result.push(path)
            }
            counter += 1
        }
        return result.flat(1)
    }

    async generatePermutations(hopCount=this.#HOP_COUNT) {
        await this.#initSwapPools()
        console.log("Generating permutations...")
        return this.#permutationHelper(hopCount, [process.env.START_TOKEN]).flat(hopCount - 1)
    }
    
    #permutationHelper(hopCount, currentPath) {
        const prevToken = currentPath[currentPath.length - 1]
        const tokenPairs = this.#swapPools.get(prevToken).get("tokenPairs")

        if (hopCount == 0) {
            if (tokenPairs.includes(currentPath[0])) {
                currentPath.push(currentPath[0])
                return currentPath
            }
        }

        let paths = []
    
        if (tokenPairs != undefined) {
            tokenPairs.forEach(token1 => {
                if (!currentPath.includes(token1)) {
                    let copyPath = structuredClone(currentPath)
                    copyPath.push(token1)
        
                    let result = this.#permutationHelper(hopCount - 1, copyPath)
        
                    if (result.length != 0) {
                        paths.push(result)
                    }
                }
            });
        }
        return paths
    }

    getReadablePaths(paths) {
        if (paths == undefined) {
            return []
        }
        
        let readablePath = []

        paths.forEach((path) => {
            let rPath = []

            path.forEach((token) => {
                if (this.#swapPools.get(token) != undefined) {
                    rPath.push(this.#swapPools.get(token).get("tokenDetails").get("identifier"))
                }
            })
            readablePath.push(rPath)
        })
        return readablePath
    }
}
