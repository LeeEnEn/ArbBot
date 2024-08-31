const fs = require('node:fs')
const {} = require('dotenv').config()

class FileRW {
    #filePath

    constructor(filePath) {
        this.#filePath = filePath
    }

    writeContents(path, readablePath, isAppend) {
        console.time("Time to write data")
        console.log("Writing contents to", this.#filePath)
        try {
            if (!isAppend) {
                fs.writeFileSync(this.#filePath, '', { flag: 'w+' })
            }
            for (let i = 0; i < path.length; i++) {
                readablePath[i].forEach(v => {
                    fs.writeFileSync(this.#filePath, v + ',', { flag: 'a'})
                })
                fs.writeFileSync(this.#filePath, "\n", { flag: 'a'})
                path[i].forEach(v => {
                    fs.writeFileSync(this.#filePath, v + ',', { flag: 'a'})
                })
                fs.writeFileSync(this.#filePath, "\n", { flag: 'a'})
            }
        } catch (err) {
            console.log("An error has occured while writing to file:\n", err)
        }
        console.timeEnd("Time to write data")
    }

    getContents() {
        console.log("Reading contents from:", this.#filePath)
        let path = []
        let readablePath = []
        try {
            let contents = fs.readFileSync(this.#filePath, { encoding: "utf-8", flag: "as+" })
            contents = contents.split('\n')

            for (let i = 0; i < contents.length; i++) {
                let data = contents[i].split(',')
                data.splice(-1, 1)

                if (i % 2 == 0) {
                    readablePath.push(data)
                } else {
                    path.push(data)
                }
            }
        } catch (err) {
            console.log("An error occured while reading file:\n", err)
        } finally {
            return [path, readablePath]
        }
    }
	
	isFileExist() {
		try {
			let contents = fs.readFileSync(this.#filePath, { encoding: "utf-8", flag: "rs" })
			if (contents == '') {
				return false
			}
			return true
		} catch (error) {
			return false
		}
	}
}

module.exports = FileRW;
