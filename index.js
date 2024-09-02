require("dotenv").config();
const axios = require("axios");
const fs = require("fs").promises;
const { spawn } = require("child_process");

const BITCOIN_RPC_URL = process.env.BITCOIN_RPC_URL;
const BITCOIN_RPC_USERNAME = process.env.BITCOIN_RPC_USERNAME;
const BITCOIN_RPC_PASSWORD = process.env.BITCOIN_RPC_PASSWORD;

const ORD_DIR_PATH = process.env.ORD_DIR_PATH;
const ORD_HOST = process.env.ORD_HOST;
const ORD_PORT = process.env.ORD_PORT;
const ORD_EXECUTABLE_PATH = process.env.ORD_EXECUTABLE_PATH;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRuneNumber(str) {
  let number = 0n;

  for (let i = 0; i < str.length; i += 1) {
    const c = str.charAt(i);
    if (i > 0) {
      number += 1n;
    }
    number *= 26n;
    if (c >= "A" && c <= "Z") {
      number += BigInt(c.charCodeAt(0) - "A".charCodeAt(0));
    } else {
      throw new Error(`Invalid character in rune name: ${c}`);
    }
  }

  return number;
}

function parseSpacedRune(str) {
  let runeStr = "";
  let spacers = 0;

  for (let i = 0; i < str.length; i++) {
    const char = str[i];

    // valid character
    if (/[A-Z]/.test(char)) {
      runeStr += char;
    } else if (char === "." || char === "•") {
      const flag = 1 << (runeStr.length - 1);
      if ((spacers & flag) !== 0) {
        throw new Error("Double spacer");
      }

      spacers |= flag;
    } else {
      throw new Error("Invalid spacer character");
    }
  }

  if (32 - Math.clz32(spacers) >= runeStr.length) {
    throw new Error("Trailing spacer");
  }

  return {
    rune: getRuneNumber(runeStr),
    spacers,
  };
}

function compareJSON(json1, json2) {
  function compare(obj1, obj2, path = "") {
    if (Array.isArray(obj1) && Array.isArray(obj2)) {
      if (obj1.length !== obj2.length) {
        console.log(`Mismatch in array length at ${path}`);
        return false;
      }
      for (let i = 0; i < obj1.length; i++) {
        if (!compare(obj1[i], obj2[i], `${path}[${i}]`)) {
          return false;
        }
      }
      return true;
    }

    if (
      typeof obj1 === "object" &&
      obj1 !== null &&
      typeof obj2 === "object" &&
      obj2 !== null
    ) {
      const keys1 = Object.keys(obj1);
      const keys2 = Object.keys(obj2);

      if (keys1.length !== keys2.length) {
        console.log(`Mismatch in number of keys at ${path}`);
        return false;
      }

      for (let i = 0; i < keys1.length; i++) {
        if (keys1[i] !== keys2[i]) {
          console.log(
            `Mismatch in key order at ${path}: ${keys1[i]} vs ${keys2[i]}`,
          );
          return false;
        }
        if (!compare(obj1[keys1[i]], obj2[keys2[i]], `${path}.${keys1[i]}`)) {
          return false;
        }
      }
      return true;
    }

    if (obj1 !== obj2) {
      console.log(`Mismatch in value at ${path}: ${obj1} vs ${obj2}`);
      return false;
    }

    return true;
  }

  return compare(json1, json2);
}

async function ordGetRunesPaged(page) {
  const response = await axios.get(
    ORD_HOST + ":" + ORD_PORT + "/runes/" + page,
    {
      headers: {
        Accept: "application/json",
      },
    },
  );

  return response.data;
}

async function ordGetBlockHeight() {
  const response = await axios.get(ORD_HOST + ":" + ORD_PORT + "/blockheight", {
    headers: {
      Accept: "application/json",
    },
  });

  return response.data;
}

async function ordGetRunesBalances() {
  const response = await axios.get(
    ORD_HOST + ":" + ORD_PORT + "/runes/balances",
    {
      headers: {
        Accept: "application/json",
      },
    },
  );

  return response.data;
}

function ordParseOutpoints(data) {
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

  results.sort((a, b) => {
    if (a.hash < b.hash) return -1;
    if (a.hash > b.hash) return 1;
    return parseInt(a.index) - parseInt(b.index);
  });

  return results;
}

async function ordCaptureState(height) {
  const [runes, balances] = await Promise.all([
    ordGetRunes(),
    ordGetRunesBalances(),
  ]);

  for (let i = 0; i < runes.length; i++) {
    const rune = runes[i];
    const runeBalances = balances[rune.spaced_rune];
    const outpoints = runeBalances ? ordParseOutpoints(runeBalances) : [];
    runes[i].outpoints = outpoints;

    delete runes[i].spaced_rune;
  }

  fs.writeFile(`ord-states/${height}.json`, JSON.stringify(runes, null, 2));
}

async function ordGetRunes() {
  let page = 0;
  let runes = [];

  while (true) {
    console.log(page);

    const data = await ordGetRunesPaged(page);
    if (page !== 0) {
      data.entries.shift();
    }

    for (const runeData of data.entries) {
      const idSplit = runeData[0].split(":");
      const entry = runeData[1];

      const { rune, spacers } = parseSpacedRune(entry.spaced_rune);

      runes.push({
        number: entry.number,
        block: parseInt(idSplit[0]),
        tx: parseInt(idSplit[1]),
        minted: entry.mints,
        burned: entry.burned,
        divisibility: entry.divisibility,
        premine: entry.premine,
        rune: rune.toString(),
        spacers,
        spaced_rune: entry.spaced_rune,
        symbol: entry.symbol || null,
        turbo: entry.turbo,
        terms: entry.terms
          ? {
            amount: entry.terms.amount || null,
            cap: entry.terms.cap || null,
            height_start: entry.terms.height[0] || null,
            height_end: entry.terms.height[1] || null,
            offset_start: entry.terms.offset[0] || null,
            offset_end: entry.terms.offset[1] || null,
          }
          : null,
      });
    }

    if (!data.more) {
      break;
    }

    page++;
  }

  return runes.reverse();
}

async function ordUpdateIndex(height) {
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

async function ordSpawnServer(height) {
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
        blockheight = await ordGetBlockHeight();
      } catch (error) {
        console.info("info.server is not up yet");
        continue;
      }

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
    await ordCaptureState(height);

    console.info("info.kill the server");
    s.kill("SIGINT");
  });
}

async function capturingStates(fromHeight, toHeight) {
  // capturing ord states
  for (let i = 0; i <= toHeight; i++) {
    const h = fromHeight + i;
    await ordUpdateIndex(h);
    const result = await ordSpawnServer(h);
    console.log({ result });
  }
}

async function runDiff() {
  const height = 840000;
  const ordStateRunes = require(`./ord-states/${height}.json`);
  const smartindexStateRunes = require(`./smartindex-states/${height}.json`);

  const result = compareJSON(ordStateRunes, smartindexStateRunes);
  if (result) {
    console.info("info.both states are same");
  }
}

async function main() {
  // await ordCaptureState(840000);
  runDiff();
}

main();
