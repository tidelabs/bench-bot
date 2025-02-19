const cp = require("child_process")
const path = require("path")
const fs = require("fs")

function errorResult(message, error) {
  return { isError: true, message, error }
}

let cwd = process.cwd()

var shell = require("shelljs")

var libCollector = require("./collector")

function BenchContext(app, config) {
  var self = this
  self.app = app
  self.config = config

  self.runTask = function (cmd, title) {
    let stdout = "",
      stderr = "",
      error = true

    try {
      if (title) {
        app.log({ title, msg: `Running task on directory ${process.cwd()}` })
      }
      // We prefer to run the command in a synchronously so that there's less
      // risk of having the Node.js process interfere or deprioritize the
      // process' execution.
      // Previously we've used cp.spawn for capturing the processes' streams
      // but, again, having it execute directly in the shell reduces the
      // likelihood of friction or overhead due to Node.js APIs.
      const result = shell.exec(cmd, { silent: false })
      stderr = result.stderr
      error = result.code !== 0
      stdout = result.stdout
    } catch (err) {
      error = true
      config.logFatal({
        msg: "Caught exception in command execution",
        error: err,
      })
    }

    return { stdout, stderr, error }
  }
}

//::node::import::native::sr25519::transfer_keep_alive::paritydb::small

const cargoRun = "cargo run --quiet --profile=production ";

var BenchConfigs = {
  import: {
    title: "Import Benchmark (random transfers)",
    benchCommand:
      cargoRun + "-p node-bench --quiet -- node::import::native::sr25519::transfer_keep_alive::rocksdb::medium --json",
  },
  "import/small": {
    title: "Import Benchmark (Small block (10tx) with random transfers)",
    benchCommand:
      cargoRun + "-p node-bench --quiet -- node::import::native::sr25519::transfer_keep_alive::rocksdb::small --json",
  },
  "import/large": {
    title: "Import Benchmark (Large block (500tx) with random transfers)",
    benchCommand:
      cargoRun + "-p node-bench --quiet -- node::import::native::sr25519::transfer_keep_alive::rocksdb::large --json",
  },
  "import/full-wasm": {
    title: "Import Benchmark (Full block with wasm, for weights validation)",
    benchCommand:
      cargoRun + "-p node-bench --quiet -- node::import::wasm::sr25519::transfer_keep_alive::rocksdb::full --json",
  },
  "import/wasm": {
    title: "Import Benchmark via wasm (random transfers)",
    benchCommand:
      cargoRun + "-p node-bench --quiet -- node::import::wasm::sr25519::transfer_keep_alive::rocksdb::medium --json",
  },
  ed25519: {
    title: "Import Benchmark (random transfers, ed25519 signed)",
    benchCommand:
      cargoRun + "-p node-bench --quiet -- node::import::native::ed25519::transfer_keep_alive::rocksdb::medium --json",
  },
}

const prepareBranch = async function (
  { contributor, owner, repo, branch, baseBranch, getPushDomain },
  { benchContext },
) {
  const gitDirectory = path.join(cwd, "git")
  shell.mkdir(gitDirectory)

  const repositoryPath = path.join(gitDirectory, repo)
  var { url } = await getPushDomain()
  benchContext.runTask(`git clone git@github.com:tidelabs/tidechain.git ${repositoryPath}`)
  shell.cd(repositoryPath)

  var { error } = benchContext.runTask("git add . && git reset --hard HEAD")
  if (error) return errorResult(stderr)

  var { error, stdout } = benchContext.runTask("git rev-parse HEAD")
  if (error) return errorResult(stderr)
  const detachedHead = stdout.trim()

  // Check out to the detached head so that any branch can be deleted
  var { error, stderr } = benchContext.runTask(`git checkout ${detachedHead}`)
  if (error) return errorResult(stderr)

  // Recreate PR remote
  benchContext.runTask("git remote remove pr")
  var { url } = await getPushDomain()
  var { error, stderr } = benchContext.runTask(
    `git remote add pr ${url}/${contributor}/${repo}.git`,
  )
  if (error)
    return errorResult(`Failed to add remote reference to ${owner}/${repo}`)

  // Fetch and recreate the PR's branch
  benchContext.runTask(`git branch -D ${branch}`)
  var { error, stderr } = benchContext.runTask(
    `git fetch pr ${branch} && git checkout --track pr/${branch}`,
    `Checking out ${branch}...`,
  )
  if (error) return errorResult(stderr)

  // Fetch and merge master
  var { error, stderr } = benchContext.runTask(
    `git pull origin ${baseBranch}`,
    `Merging branch ${baseBranch}`,
  )
  if (error) return errorResult(stderr)
}

async function benchBranch(app, config) {
  app.log("Waiting our turn to run benchBranch...")

  try {
    if (config.repo != "substrate") {
      return errorResult("Node benchmarks only available on Substrate.")
    }

    var id = config.id
    var benchConfig = BenchConfigs[id]
    if (!benchConfig) {
      return errorResult(`Bench configuration for "${id}" was not found`)
    }

    const collector = new libCollector.Collector()
    var benchContext = new BenchContext(app, config)
    var { title, benchCommand } = benchConfig
    app.log(`Started benchmark "${title}."`)

    var error = await prepareBranch(config, { benchContext })
    if (error) return error

    var { stderr, error, stdout } = benchContext.runTask(
      benchCommand,
      `Benching branch ${config.branch}...`,
    )
    if (error) return errorResult(stderr)

    await collector.CollectBranchCustomRunner(stdout)
    let output = await collector.Report()

    return { title, output, extraInfo: "", benchCommand }
  } catch (error) {
    return errorResult("Caught exception in benchBranch", error)
  }

}

var SubstrateRuntimeBenchmarkConfigs = {
  pallet: {
    title: "Runtime Pallet",
    benchCommand: [
      cargoRun,
      "--features=runtime-benchmarks",
      "--manifest-path=bin/node/cli/Cargo.toml",
      "--",
      "benchmark",
      "pallet",
      "--chain=dev",
      "--steps=50",
      "--repeat=20",
      "--pallet={pallet_name}",
      '--extrinsic="*"',
      "--execution=wasm",
      "--wasm-execution=compiled",
      "--heap-pages=4096",
      "--output=./frame/{pallet_folder}/src/weights.rs",
      "--template=./.maintain/frame-weight-template.hbs",
    ].join(" "),
  },
  substrate: {
    title: "Runtime Substrate Pallet",
    benchCommand: [
      cargoRun,
      "--features=runtime-benchmarks",
      "--manifest-path=bin/node/cli/Cargo.toml",
      "--",
      "benchmark",
      "pallet",
      "--chain=dev",
      "--steps=50",
      "--repeat=20",
      "--pallet={pallet_name}",
      '--extrinsic="*"',
      "--execution=wasm",
      "--wasm-execution=compiled",
      "--heap-pages=4096",
      "--output=./frame/{pallet_folder}/src/weights.rs",
      "--template=./.maintain/frame-weight-template.hbs",
    ].join(" "),
  },
  custom: {
    title: "Runtime Custom",
    benchCommand:
      cargoRun + "--features runtime-benchmarks --manifest-path bin/node/cli/Cargo.toml -- benchmark",
  },
}

var TidechainRuntimeBenchmarkConfigs = {
  pallet: {
    title: "Runtime Pallet",
    benchCommand: [
      cargoRun,
      "--features=runtime-benchmarks",
      "--",
      "benchmark",
      "pallet",
      "--chain=tidechain-dev",
      "--steps=50",
      "--repeat=20",
      "--pallet={pallet_name}",
      '--extrinsic="*"',
      "--execution=wasm",
      "--wasm-execution=compiled",
      "--heap-pages=4096",
      "--header=./FILE_TEMPLATE",
      "--output=./runtime/tidechain/src/weights/{output_file}",
    ].join(" "),
  },
  tidechain: {
    title: "Runtime Tidechain Pallet",
    benchCommand: [
      cargoRun,
      "--features=runtime-benchmarks",
      "--",
      "benchmark",
      "pallet",
      "--chain=tidechain-dev",
      "--steps=50",
      "--repeat=20",
      "--pallet={pallet_name}",
      '--extrinsic="*"',
      "--execution=wasm",
      "--wasm-execution=compiled",
      "--heap-pages=4096",
      "--header=./FILE_TEMPLATE",
      "--output=./runtime/tidechain/src/weights/{output_file}",
    ].join(" "),
  },
  lagoon: {
    title: "Runtime lagoon Pallet",
    benchCommand: [
      cargoRun,
      "--features=runtime-benchmarks",
      "--",
      "benchmark",
      "pallet",
      "--chain=lagoon-dev",
      "--steps=50",
      "--repeat=20",
      "--pallet={pallet_name}",
      '--extrinsic="*"',
      "--execution=wasm",
      "--wasm-execution=compiled",
      "--heap-pages=4096",
      "--header=./FILE_TEMPLATE",
      "--output=./runtime/lagoon/src/weights/{output_file}",

    ].join(" "),
  },
  custom: {
    title: "Runtime Custom",
    benchCommand:
      cargoRun + "--features runtime-benchmarks -- benchmark",
  },
}


function checkRuntimeBenchmarkCommand(command) {
  let required = [
    "benchmark",
    "pallet",    
    "--pallet",
    "--extrinsic",
    "--execution",
    "--wasm-execution",
    "--steps",
    "--repeat",
    "--chain",
  ]
  let missing = []
  for (const flag of required) {
    if (!command.includes(flag)) {
      missing.push(flag)
    }
  }

  return missing
}

function checkAllowedCharacters(command) {
  let banned = ["#", "&", "|", ";"]
  for (const token of banned) {
    if (command.includes(token)) {
      return false
    }
  }

  return true
}

async function benchmarkRuntime(app, config) {
  app.log("Waiting our turn to run benchmarkRuntime...")

  try {
    if (config.extra.split(" ").length < 2) {
      return errorResult(`Incomplete command.`)
    }

    let command = config.extra.split(" ")[0]

    var benchConfig
    if (config.repo == "substrate" && config.id == "runtime") {
      benchConfig = SubstrateRuntimeBenchmarkConfigs[command]
    } else if (config.repo == "tidechain" && config.id == "runtime") {
      benchConfig = TidechainRuntimeBenchmarkConfigs[command]
    } else {
      return errorResult(
        `${config.repo} repo with ${config.id} is not supported.`,
      )
    }

    var extra = config.extra.split(" ").slice(1).join(" ").trim()

    if (!checkAllowedCharacters(extra)) {
      return errorResult(`Not allowed to use #&|; in the command!`)
    }

    // Append extra flags to the end of the command
    let benchCommand = benchConfig.benchCommand
    if (command == "custom") {
      // extra here should just be raw arguments to add to the command
      benchCommand += " " + extra
    } else {
      // extra here should be the name of a pallet
      benchCommand = benchCommand.replace("{pallet_name}", extra)
      // custom output file name so that pallets with path don't cause issues
      let outputFile = extra.includes("::")
        ? extra.replace("::", "_") + ".rs"
        : ""
      benchCommand = benchCommand.replace("{output_file}", outputFile)
      // pallet folder should be just the name of the pallet, without the leading
      // "pallet_" or "frame_", then separated with "-"
      let palletFolder = extra.split("_").slice(1).join("-").trim()
      benchCommand = benchCommand.replace("{pallet_folder}", palletFolder)
    }

    let missing = checkRuntimeBenchmarkCommand(benchCommand)
    if (missing.length > 0) {
      return errorResult(`Missing required flags: ${missing.toString()}`)
    }

    var benchContext = new BenchContext(app, config)
    var { title } = benchConfig
    app.log(
      `Started ${config.id} benchmark "${title}." (command: ${benchCommand})`,
    )

    var error = await prepareBranch(config, { benchContext })
    if (error) return error

    const outputFile = benchCommand.match(/--output(?:=|\s+)(".+?"|\S+)/)[1]
    var { stdout, stderr } = benchContext.runTask(
      benchCommand,
      `Running for branch ${config.branch}, ${outputFile ? `outputFile: ${outputFile}` : ""
      }: ${benchCommand}`,
    )
    let extraInfo = ""

    var { stdout: gitStatus, stderr: gitStatusError } =
      benchContext.runTask("git status --short")
    app.log(`Git status after execution: ${gitStatus || gitStatusError}`)

    if (outputFile) {
      if (process.env.DEBUG) {
        app.log({
          context: "Output file",
          msg: fs.readFileSync(outputFile).toString(),
        })
      } else {
        try {
          var last = benchContext.runTask(
            `git add ${outputFile} && git commit -m "${benchCommand}"`,
          )
          if (last.error) {
            extraInfo = `ERROR: Unable to commit file ${outputFile}`
            config.logFatal({
              msg: extraInfo,
              stdout: last.stdout,
              stderr: last.stderr,
            })
          } else {
            const target = `${config.contributor}/${config.repo}`
            const { url, token } = await config.getPushDomain()
            var last = benchContext.runTask(
              `git remote set-url pr ${url}/${target}.git && git push pr HEAD`,
              `Pushing ${outputFile} to ${config.branch}`,
            )
            if (last.error) {
              extraInfo = `ERROR: Unable to push ${outputFile}`
              config.logFatal({
                msg: extraInfo,
                stdout: last.stdout,
                stderr: last.stderr,
              })
            }
          }
        } catch (error) {
          extraInfo =
            "NOTE: Caught exception while trying to push commits to the repository"
          config.logFatal({ msg: extraInfo, error })
        }
      }
    }

    return {
      title,
      output: stdout ? stdout : stderr,
      extraInfo,
      benchCommand,
    }
  } catch (error) {
    return errorResult("Caught exception in benchmarkRuntime", error)
  }
}

async function benchRustup(app, config) {
  app.log("Waiting our turn to run benchRustup...")

  try {
    // right now only `rustup update` is supported.
    if (config.extra != "update") {
      return errorResult(`Invalid "rustup" command. Only "update" is supported.`)
    }

    const collector = new libCollector.Collector()
    var benchContext = new BenchContext(app, config)

    let benchCommand = "rustup update";
    let title = "Rustup Update";

    var { stderr, error, stdout } = benchContext.runTask(
      benchCommand,
      `Executing "rustup update"...`,
    )
    if (error) return errorResult(stderr)

    return {
      title,
      output: stdout ? stdout : stderr,
      extraInfo: "",
      benchCommand
    }
  } catch (error) {
    return errorResult("Caught exception in benchRustup", error)
  }
}

module.exports = {
  benchBranch: benchBranch,
  benchmarkRuntime: benchmarkRuntime,
  benchRustup: benchRustup,
}
