const { ethers, BigNumber } = require('ethers')
const {} = require('dotenv').config()

class Functions {
    #provider
    #wallet

    constructor() {     
        this.#provider = new ethers.providers.JsonRpcProvider(process.env.RPC)
        this.#wallet = process.env.USE_MNEMONIC ? ethers.Wallet.fromMnemonic(process.env.MNEMONIC).connect(this.#provider)
                                                : new ethers.Wallet(process.env.PRIVATE_KEY).connect(this.#provider)
    }
    
    getProvider() {
        return this.#provider
    }
    
    getWallet() {
        return this.#wallet
    }

    getWalletAddress() {
        return this.#wallet.address
    }
    
    async isConnectedToRPC() {
        await this.#provider._getConnection().send()
            .then(result => {return result.ok()})
            .catch(error => {return false});
    }
    
    async getWalletBalance() {
        return ethers.utils.formatEther(await this.#provider.getBalance(this.getWalletAddress()))
    }
    
    async getGasFee() {
        return ethers.utils.formatUnits((await this.#provider.getFeeData()).gasPrice, "gwei")
    }
}

module.exports = Functions;
