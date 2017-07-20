const getOptions = require('mocha/bin/options')
const url = require('url')
const {
  assign,
  debounce,
  each,
  union
} = require('lodash')
const {
  resolve
} = require('path')
const {
  BrowserWindow,
  app,
  ipcMain
} = require('electron')
const Coverage = require('./lib/Coverage')
const parseArgs = require('./lib/parseArgs')
const runMocha = require('./lib/runMocha')
const watcher = require('./lib/watcher')
const windowBoundsConfig = require('./lib/windowBoundsConfig')(resolve(app.getPath('userData'), './torch-config.json'))

function fail (error) {
  console.error(error.message)
  console.error(error.stack)
  app.exit(1)
}

// load mocha.opts into process.argv
getOptions()

// opts
const opts = parseArgs(process.argv)
opts.root = process.cwd()

// `--require-main` scripts
if (opts.requireMain.length) {
  try {
    each(opts.requireMain, mainModule => {
      require(mainModule)
    })
  } catch (error) {
    fail(error)
  }
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
  app.exit()
})
app.on('ready', () => {
  if (opts.interactive) {
    opts.renderer = true
    opts.debug = true
    opts.reporter = 'HTML'
  }
  if (!opts.renderer) {
    let coverage
    try {
      if (opts.coverage) {
        coverage = new Coverage(opts.root, opts.sourcePattern)
      }
      runMocha(opts, count => {
        if (coverage) {
          coverage.report()
        }
        app.exit(count)
      })
    } catch (error) {
      fail(error)
    }
  } else {
    const winOpts = {
      focusable: opts.debug,
      height: opts.height,
      show: false,
      width: opts.width,
      webPreferences: {
        webSecurity: false
      }
    }
    assign(winOpts, windowBoundsConfig.get('main'))
    let win = new BrowserWindow(winOpts)

    win.on('close', () => {
      windowBoundsConfig.set('main', win.getBounds())
    })
    win.on('closed', () => {
      win = null
    })
    win.webContents.once('did-finish-load', () => {
      if (opts.debug) {
        win.show()
        win.webContents.openDevTools()
        win.webContents.on('devtools-opened', () => {
          // Debugger is not immediately ready!
          setTimeout(() => {
            win.webContents.send('mocha-start')
          }, 250)
        })

        // Called on reload in --interactive mode
        ipcMain.on('mocha-ready-to-run', () => {
          win.webContents.send('mocha-start')
        })
      } else {
        win.webContents.send('mocha-start')
      }
    })

    if (opts.interactive && opts.watch) {
      watcher(
        union(opts.sourcePattern, opts.files),
        debounce(() => {
          console.log('executed')
          win.webContents.reloadIgnoringCache()
        }, opts.watchAggregateTimeout)
      )
    }

    ipcMain.on('mocha-done', (event, count) => {
      win.webContents.once('destroyed', () => app.exit(count))
      if (!opts.interactive) {
        win.close()
      }
    })
    ipcMain.on('mocha-error', (_, error) => fail(error))

    win.loadURL(url.format({
      hash: encodeURIComponent(JSON.stringify(opts)),
      pathname: resolve(__dirname, './renderer/index.html'),
      protocol: 'file:',
      slashes: true
    }))

    if (!opts.debug && process.platform === 'darwin') {
      app.dock.hide()
    }
  }
})
