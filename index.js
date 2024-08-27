require("dotenv").config();
const axios = require("axios");
const fs = require("fs").promises;
const { spawn } = require("child_process");

const BITCOIN_RPC_URL = process.env.BITCOIN_RPC_URL;
const BITCOIN_RPC_USERNAME = process.env.BITCOIN_RPC_USERNAME;
const BITCOIN_RPC_PASSWORD = process.env.BITCOIN_RPC_PASSWORD;

const ORD_DIR_PATH = process.env.ORD_DIR_PATH;
const ORD_PORT = process.env.ORD_PORT;
const ORD_EXECUTABLE_PATH = process.env.ORD_EXECUTABLE_PATH;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getBlockHeight() {
  const response = await axios.get(
    "http://localhost:" + ORD_PORT + "/blockheight",
    {
      headers: {
        Accept: "application/json",
      },
    },
  );

  return response.data;
}

async function getRunesBalances() {
  const response = await axios.get(
    "http://localhost:" + ORD_PORT + "/runes/balances",
    {
      headers: {
        Accept: "application/json",
      },
    },
  );

  return response.data;
}

async function getRune(runeName) {
  const response = await axios.get(
    "http://localhost:" + ORD_PORT + "/rune/" + runeName,
    {
      headers: {
        Accept: "application/json",
      },
    },
  );
  return response.data;
}

function parseOutpoints(data) {
  const results = [];
  const dataKeys = Object.keys(data);

  for (const key of dataKeys) {
    const keyParts = key.split(":");
    results.push({
      hash: keyParts[0],
      index: keyParts[1],
      amount: data[key],
    });
  }

  return results;
}

async function captureState(height) {
  const balances = await getRunesBalances();
  const balancesKeys = Object.keys(balances);

  const results = [];
  for (const key of balancesKeys) {
    const rune = await getRune(key);
    results.push({
      ...rune,
      outpoints: parseOutpoints(balances[key]),
    });
  }

  fs.writeFile(
    `json-tests/${height}-runes.json`,
    JSON.stringify({ height, runes: results }, null, 2),
  );
}

async function updateIndex(height) {
  const args = [
    "--chain",
    "mainnet",
    "--bitcoin-rpc-url",
    BITCOIN_RPC_URL,
    "--bitcoin-rpc-password",
    BITCOIN_RPC_PASSWORD,
    "--bitcoin-rpc-username",
    BITCOIN_RPC_USERNAME,
    "--index-runes",
    "--no-index-inscriptions",
    "--height-limit",
    (height + 1).toString(),
    "--data-dir",
    ORD_DIR_PATH,
    "index",
    "update",
  ];
  console.info("info.updating index for height: ", height);
  const update = spawn(ORD_EXECUTABLE_PATH, args);

  return new Promise((resolve, reject) => {
    update.stdout.on("data", (data) => {
      console.log("data");
      console.log(`stdout: ${data}`);
    });

    update.stderr.on("data", (data) => {
      console.log("error");
      console.log(data);
    });

    update.on("error", (error) => {
      reject(error);
    });

    update.on("close", (code) => {
      resolve(code);
    });
  });
}

async function spawnServer(height) {
  const args = [
    "--chain",
    "mainnet",
    "--bitcoin-rpc-url",
    BITCOIN_RPC_URL,
    "--bitcoin-rpc-password",
    BITCOIN_RPC_PASSWORD,
    "--bitcoin-rpc-username",
    BITCOIN_RPC_USERNAME,
    "--index-runes",
    "--no-index-inscriptions",
    "--height-limit",
    (height + 1).toString(),
    "--data-dir",
    ORD_DIR_PATH,
    "server",
    "--http-port",
    ORD_PORT.toString(),
  ];
  console.info("info.spawning server");
  const s = spawn(ORD_EXECUTABLE_PATH, args);

  return new Promise(async (resolve, reject) => {
    s.stdout.on("data", (data) => {
      console.log(`stdout: ${data.toString()}`);
    });

    s.stderr.on("data", (data) => {
      console.log(`stderr: ${data.toString()}`);
    });

    s.on("error", (error) => {
      reject(error);
    });

    s.on("close", (code) => {
      resolve(code);
    });

    while (true) {
      console.info("info.waiting for the server to be up");
      let blockheight = -1;
      try {
        blockheight = await getBlockHeight();
      } catch (error) {
        console.info("info.server is not up yet");
        continue;
      }

      console.log({ blockheight });

      if (blockheight === height) {
        console.info("info.server is up");
        break;
      } else if (blockheight > height) {
        console.info(
          "info.server messed up, blockheight is greater than height",
        );
        reject("blockheight is greater than height");
      }
      await sleep(500);
    }

    console.info("info.capturing the state on height: ", height);
    await captureState(height);

    console.info("info.kill the server");
    s.kill("SIGINT");
  });
}

async function main() {
  for (let i = 0; i < 3; i++) {
    const height = 840000 + i;
    await updateIndex(height);
    const result = await spawnServer(height);
    console.log({ result });
  }
}

main();
