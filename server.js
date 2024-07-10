const express = require("express");
const multer = require("multer");
const bodyParser = require("body-parser");
const cors = require("cors");
const fs = require("fs");
const WebSocket = require("ws");
const {
  Connection,
  PublicKey,
  Keypair,
  LAMPORTS_PER_SOL,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} = require("@solana/web3.js");
const bip39 = require("bip39");
const { derivePath } = require("ed25519-hd-key");
const XLSX = require("xlsx");

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

const upload = multer({ dest: "uploads/" });

let BATCH_SIZE = 25;
let maxCount = 100;
let maxFailures = 30;

const connect = new Connection("https://devnet.sonic.game", "confirmed");

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

app.post("/upload", upload.single("file"), (req, res) => {
  const file = req.file;
  if (!file) {
    return res.status(400).send("上传失败，请选择文件。");
  }

  const workbook = XLSX.readFile(file.path);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  let keysData = XLSX.utils.sheet_to_json(sheet, { header: 1 });
  keysData = shuffle(keysData);

  global.keysData = keysData;

  res.send("助记词已读取完成，可以开始执行交易。");
});

app.get("/mnemonics", (req, res) => {
  if (!global.keysData) {
    return res.status(400).send("对不起，你需要先上传助记词文件！");
  }

  const mnemonics = global.keysData.map((row) => row[0]);
  res.json(mnemonics);
});

app.post("/set-config", (req, res) => {
  const { batchSize, maxTransactionCount, maxFailureCount } = req.body;

  BATCH_SIZE = parseInt(batchSize);
  maxCount = parseInt(maxTransactionCount);
  maxFailures = parseInt(maxFailureCount);

  res.send("设置成功。");
});

const wss = new WebSocket.Server({ noServer: true });

app.get("/execute", async (req, res) => {
  if (!global.keysData) {
    return res.status(400).send("对不起，你需要先上传助记词文件！");
  }

  const keysData = global.keysData;
  const TOTAL_ROWS = keysData.length;
  let terminationLogs = [];
  let logs = [];

  const broadcast = (message) => {
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  };

  let whileFun = async (pay) => {
    let count = 0;
    let failCount = 0;
    while (count < maxCount && failCount < maxFailures) {
      let { success, result, error, log } = await toTransaction(pay, count);
      logs.push(log);
      broadcast(log);
      if (!success) {
        failCount++;
      } else {
        count++;
      }

      let time = 5000 + Math.random() * 5000;
      await new Promise((resolve) => setTimeout(resolve, time));
    }
    if (failCount >= maxFailures) {
      const terminationLog = `地址 ${pay.publicKey.toBase58()} 达到最大失败次数 (${maxFailures}) 并停止于 ${new Date().toISOString()}\n`;
      terminationLogs.push(terminationLog);
      console.log(terminationLog);
      broadcast(terminationLog);
    }
  };

  async function processBatch(startRow, endRow) {
    const keysData_s = keysData.slice(startRow, endRow);
    const promises = keysData_s.map(async (row) => {
      const mnemonic = row[0];
      const seed = bip39.mnemonicToSeedSync(mnemonic);
      const derivedSeed = derivePath(
        "m/44'/501'/0'/0'",
        seed.toString("hex")
      ).key;
      const pay = Keypair.fromSeed(derivedSeed);

      const delay = 4000 + Math.random() * 10000;
      await new Promise((resolve) => setTimeout(resolve, delay));
      return whileFun(pay);
    });
    await Promise.all(promises);
  }

  async function processAllBatches() {
    for (let startRow = 0; startRow < TOTAL_ROWS; startRow += BATCH_SIZE) {
      const endRow = Math.min(startRow + BATCH_SIZE, TOTAL_ROWS);
      console.log(`开始处理 ${startRow}行至 ${endRow}行`);
      broadcast(`开始处理  ${startRow}行至 ${endRow}行`);
      await processBatch(startRow, endRow);
    }
    console.log("所有执行全部完成。");
    broadcast("所有执行全部完成。");
    if (terminationLogs.length > 0) {
      console.error("Terminations:", terminationLogs);
      fs.writeFileSync(
        "termination_logs.txt",
        terminationLogs.join(""),
        "utf8"
      );
    }
  }

  try {
    await processAllBatches();
    res.send("任务结束。");
  } catch (error) {
    console.error("An error occurred:", error);
    res.status(500).send("An error occurred during execution.");
  }
});

app.server = app.listen(3000, () => {
  console.log("Server running on port 3000");
});

wss.on("connection", (ws) => {
  console.log("New WebSocket connection");
  ws.on("message", (message) => {
    console.log("Received:", message);
  });
});

app.server.on("upgrade", (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, request);
  });
});

async function toTransaction(pay, count) {
  const keypair = Keypair.generate();
  const publicKey = keypair.publicKey.toString();
  let toPubkey = new PublicKey(publicKey);
  let amount = parseInt(7000000 * parseFloat(Math.random().toFixed(2)));

  try {
    let instruction = SystemProgram.transfer({
      fromPubkey: pay.publicKey,
      toPubkey: toPubkey,
      lamports: amount,
    });

    let latestBlockhash = await connect.getLatestBlockhash();
    let messageV0 = new TransactionMessage({
      payerKey: pay.publicKey,
      recentBlockhash: latestBlockhash.blockhash,
      instructions: [instruction],
    }).compileToV0Message();

    let transaction = new VersionedTransaction(messageV0);
    transaction.sign([pay]);
    let result = await connect.sendTransaction(transaction);
    if (!result) {
      throw { message: "交易失败" };
    }
    console.info(`${pay.publicKey.toBase58()} - 第${count + 1}次交易：`);
    console.info(
      `Success! To ${result} Send ${amount / LAMPORTS_PER_SOL}Sol \n`
    );
    return {
      success: true,
      result,
      log: `【${pay.publicKey.toBase58()}】- 第${
        count + 1
      }次交易：Success! To ${publicKey} Send ${
        amount / LAMPORTS_PER_SOL
      }Sol \n`,
    };
  } catch (err) {
    console.info(`${pay.publicKey.toBase58()} - 第${count + 1}次交易：`);
    console.info(`Fail - error:`, err.message, "\n");
    return {
      success: false,
      error: err.message,
      log: `【${pay.publicKey.toBase58()}】- 第${
        count + 1
      }次交易：Fail - error:${err.message} \n`,
    };
  }
}
