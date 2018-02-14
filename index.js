'use strict'

const DatLibrarian = require('dat-librarian')
const fs = require('fs')
const http = require('http')
const hyperdriveHttp = require('hyperdrive-http')
const path = require('path')

function log () {
  let msg = arguments[0]
  arguments[0] = '[dat-gateway] ' + msg
  if (process.env.DEBUG || process.env.LOG) {
    console.log.apply(console, arguments)
  }
}

module.exports =
class DatGateway extends DatLibrarian {
  constructor ({ dir, dat, max, net, period, ttl }) {
    dat = dat || {}
    dat.temp = dat.temp || true // store dats in memory only
    super({ dir, dat, net })
    this.max = max
    this.ttl = ttl
    this.period = period
    this.lru = {}
    if (this.ttl && this.period) {
      this.cleaner = setInterval(() => {
        log('Checking for expired archives...')
        const tasks = Object.keys(this.dats).filter((key) => {
          const now = Date.now()
          let lastRead = this.lru[key]
          return (lastRead && ((now - lastRead) > this.ttl))
        }).map((key) => {
          log('Deleting expired archive %s', key)
          delete this.lru[key]
          return this.remove(key)
        })
        return Promise.all(tasks)
      }, this.period)
    }
  }

  load () {
    log('Setting up...')
    return this.getHandler().then((handler) => {
      log('Setting up server...')
      this.server = http.createServer(handler)
    }).then(() => {
      log('Loading pre-existing archives...')
      // load pre-existing archives
      return super.load()
    })
  }

  /**
   * Promisification of server.listen()
   * @param  {Number} port Port to listen on.
   * @return {Promise}     Promise that resolves once the server has started listening.
   */
  listen (port) {
    return new Promise((resolve, reject) => {
      this.server.listen(port, (err) => {
        if (err) return reject(err)
        else return resolve()
      })
    })
  }

  close () {
    if (this.cleaner) clearInterval(this.cleaner)
    return new Promise((resolve) => {
      if (this.server) this.server.close(resolve)
      else resolve()
    }).then(() => {
      return super.close()
    })
  }

  getIndexHtml () {
    return new Promise((resolve, reject) => {
      let filePath = path.join(__dirname, 'index.html')
      fs.readFile(filePath, 'utf-8', (err, html) => {
        if (err) return reject(err)
        else return resolve(html)
      })
    })
  }

  getHandler () {
    return this.getIndexHtml().then((welcome) => {
      return (req, res) => {
        const start = Date.now()
        // TODO redirect /:key to /:key/
        let urlParts = req.url.split('/')
        let address = urlParts[1]
        let path = urlParts.slice(2).join('/')
        log('[%s] %s %s', address, req.method, path)
        // return index
        if (!address && !path) {
          res.writeHead(200)
          res.end(welcome)
          return Promise.resolve()
        }
        // return the archive
        return this.add(address).then((dat) => {
          // handle it!!
          const end = Date.now()
          log('[%s] %s %s | OK [%i ms]', address, req.method, path, end - start)
          req.url = `/${path}`
          dat.onrequest(req, res)
        }).catch((e) => {
          const end = Date.now()
          log('[%s] %s %s | ERROR %s [%i ms]', address, req.method, path, e.message, end - start)
          if (e.message.indexOf('not found') > -1) {
            res.writeHead(404)
            res.end('Not found')
          } else {
            res.writeHead(500)
            res.end(JSON.stringify(e))
          }
        })
      }
    })
  }

  add () {
    if (this.keys.length >= this.max) {
      const error = new Error('Cache is full. Cannot add more archives.')
      return Promise.reject(error)
    }
    return super.add.apply(this, arguments).then((dat) => {
      log('Adding HTTP handler to archive...')
      if (!dat.onrequest) dat.onrequest = hyperdriveHttp(dat.archive, { live: true, exposeHeaders: true })
      return new Promise((resolve) => {
        /*
        Wait for the archive to populate OR for 3s to pass,
        so that addresses for archives which don't exist
        don't hold us up all night.
         */
        let isDone = false
        const done = () => {
          if (isDone) return null
          isDone = true
          const key = dat.archive.key.toString('hex')
          this.lru[key] = Date.now()
          return resolve(dat)
        }
        dat.archive.metadata.update(1, done)
        setTimeout(done, 3000)
      })
    })
  }
}
