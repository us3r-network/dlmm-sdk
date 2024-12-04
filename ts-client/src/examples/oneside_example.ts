import {
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  Transaction,
  SystemProgram,
} from "@solana/web3.js";
import { DLMM } from "../dlmm";
import { BinLiquidity, LbPosition, StrategyType } from "../dlmm/types";
import { deriveLbPair2, derivePresetParameter2 } from "../dlmm/helpers";
import { AnchorProvider, BN, Program, Wallet, web3 } from "@coral-xyz/anchor";
import { LBCLMM_PROGRAM_IDS } from "../dlmm/constants";
import { ASSOCIATED_TOKEN_PROGRAM_ID, createMint, getOrCreateAssociatedTokenAccount, mintTo, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { computeBaseFactorFromFeeBps } from "../dlmm/helpers/math";
import { IDL } from "../dlmm/idl";


const byteArray = [89,178,192,81,49,83,87,144,176,217,60,218,47,63,151,131,91,160,163,32,99,27,213,181,31,2,42,10,81,107,162,59,98,54,29,147,59,235,168,220,148,237,25,61,203,172,227,49,141,74,62,100,6,184,28,245,1,153,14,74,163,132,31,111];
const user = Keypair.fromSecretKey(
  new Uint8Array(byteArray)
);
const RPC = process.env.RPC || "https://mainnet.helius-rpc.com/?api-key=02d1bef9-8593-4e92-859e-5c4240f27d22";
const connection = new Connection(RPC, "finalized");
const keypair = Keypair.fromSecretKey(
  new Uint8Array(byteArray)
);

const poolAddress = new PublicKey(
  "3W2HKgUa96Z69zzG3LK1g8KdcRAWzAttiLiHfYnKuPw5"
);

/** Utils */
export interface ParsedClockState {
  info: {
    epoch: number;
    epochStartTimestamp: number;
    leaderScheduleEpoch: number;
    slot: number;
    unixTimestamp: number;
  };
  type: string;
  program: string;
  space: number;
}

let activeBin: BinLiquidity;
let userPositions: LbPosition[] = [];

const newBalancePosition = new Keypair();
const newImbalancePosition = new Keypair();
const newOneSidePosition = new Keypair();

async function getActiveBin(dlmmPool: DLMM) {
  // Get pool state
  activeBin = await dlmmPool.getActiveBin();
  console.log("🚀 ~ activeBin:", activeBin);
}

async function confirmTransaction(connection: Connection, signature: string) {
  const latestBlockhash = await connection.getLatestBlockhash();
  return await connection.confirmTransaction({
    signature,
    ...latestBlockhash
  }, 'finalized');
}

async function sendTransactionWithRetry(connection: Connection, transaction: web3.Transaction, signers: Keypair[], maxRetries: number = 3) {
  let retries = 0;
  let signature;
  while (retries < maxRetries) {
    try {
      signature = await sendAndConfirmTransaction(connection, transaction, signers, {
        skipPreflight: false,
        preflightCommitment: 'finalized',
        commitment: 'finalized',
      });
      await confirmTransaction(connection, signature);
      return signature;
    } catch (error) {
      console.log(`Transaction failed with error: ${error}. Retrying... (${retries + 1}/${maxRetries})`);
      retries++;
    }
  }
  throw new Error('Transaction failed after maximum retries');
}

async function sendTransactionWithPriorityFee(connection: Connection, transaction: web3.Transaction, signers: Keypair[], priorityFee: number) {
  // Set the priority fee
  transaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  transaction.feePayer = signers[0].publicKey;

  // Add priority fee to the transaction
  transaction.add(
    SystemProgram.transfer({
      fromPubkey: signers[0].publicKey,
      toPubkey: signers[0].publicKey, // Self-transfer to increase fee
      lamports: priorityFee,
    })
  );

  // Get the current block height and set a last valid block height
  const currentBlockHeight = await connection.getBlockHeight();

  // Sign and send the transaction
  transaction.sign(...signers);

  try {
    const signature = await sendAndConfirmTransaction(connection, transaction, signers, {
      skipPreflight: false,
      preflightCommitment: 'finalized',
      commitment: 'finalized',
    });
    await confirmTransaction(connection, signature);
    return signature;
  } catch (error) {
    console.log(`Transaction failed with error: ${error}`);
    throw error;
  }
}

async function createPool() {
  console.log("🚀 ~ creating");
  // 1. 创建两个代币 mint
  const tokenXDecimals = 9;
  const tokenYDecimals = 9;
  const tokenX = await createMint(
    connection,
    keypair,
    keypair.publicKey,
    null,
    tokenXDecimals,
    Keypair.generate(),
    null,
    TOKEN_PROGRAM_ID
  );
  const tokenY = new PublicKey("So11111111111111111111111111111111111111112"); // Mainnet SOL
  console.log("🚀 ~ tokenX:", tokenX.toString());
  console.log("🚀 ~ tokenY:", tokenY.toString());

  // 2. 为用户创建代币账户并铸造代币
  const userTokenX = await getOrCreateAssociatedTokenAccount(
    connection,
    keypair,
    tokenX,
    keypair.publicKey
  );
  const userTokenY = await getOrCreateAssociatedTokenAccount(
    connection,
    keypair,
    tokenY,
    keypair.publicKey
  );

  await mintTo(
    connection,
    keypair,
    tokenX,
    userTokenX.address,
    keypair.publicKey,
    1000000 * 10 ** tokenXDecimals
  );
  // await mintTo(
  //   connection,
  //   keypair,
  //   tokenY,
  //   userTokenY.address,
  //   keypair.publicKey,
  //   1000000 * 10 ** tokenYDecimals
  // );

  console.log("🚀 ~ userTokenX:", userTokenX.address.toString());
  console.log("🚀 ~ userTokenY:", userTokenY.address.toString());
  // 3. 计算 pool address
  const feeBps = new BN(10); // 0.1%的费用
  const binStep = new BN(100); // 1%的步长
  const baseFactor = computeBaseFactorFromFeeBps(binStep, feeBps);
  const programId = new web3.PublicKey(LBCLMM_PROGRAM_IDS["mainnet-beta"]);

  // 4.初始化 preset parameter pda
  const [presetParamPda] = derivePresetParameter2(
    binStep,
    baseFactor,
    programId
  );
  // 添加检查逻辑
  const presetParamAccount = await connection.getAccountInfo(presetParamPda);
  // 只有当账户不存在时才初始化
  if (!presetParamAccount) {
    const provider = new AnchorProvider(
      connection,
      new Wallet(keypair),
      AnchorProvider.defaultOptions()
    );
    const program = new Program(
      IDL,
      LBCLMM_PROGRAM_IDS["mainnet-beta"],
      provider
    );
    
    await program.methods.initializePresetParameter({
      binStep: binStep.toNumber(),
      baseFactor: baseFactor.toNumber(),
      filterPeriod: 30,
      decayPeriod: 600,
      reductionFactor: 5000,
      variableFeeControl: 40000,
      protocolShare: 0,
      maxBinId: 43690,
      minBinId: -43690,
      maxVolatilityAccumulator: 350000,
    })
    .accounts({
      admin: keypair.publicKey,
      presetParameter: presetParamPda,
      rent: web3.SYSVAR_RENT_PUBKEY,
      systemProgram: web3.SystemProgram.programId,
    })
    .signers([keypair])
    .rpc({
      commitment: "confirmed",
    });
  }
  console.log("🚀 ~ presetParamPda:", presetParamPda.toString());

  // 5. 创建 lb pair pda
  const DEFAULT_ACTIVE_ID = new BN(0);
  const rawTx = await DLMM.createLbPair(
    connection,
    keypair.publicKey,
    tokenX,
    tokenY,
    binStep,
    baseFactor,
    presetParamPda,
    DEFAULT_ACTIVE_ID,
    { cluster: "mainnet-beta" }
  );
  const signature = await sendTransactionWithRetry(connection, rawTx, [keypair]);
  console.log("🚀 ~ rawTx:", rawTx);
  const [lbPairPubkey] = deriveLbPair2(
    tokenX,
    tokenY,
    binStep,
    baseFactor,
    programId
  );
  console.log("🚀 ~ lbPairPubkey:", tokenX.toString(), tokenY.toString(), lbPairPubkey.toString());

  // 6. 创建 DLMM 实例
  const dlmmPool = await DLMM.create(connection, lbPairPubkey, {
    cluster: "mainnet-beta",
  });

  // 7. 初始化池子，设置初始价格为 2
  const initPrice = 2;
  const activeId = dlmmPool.getBinIdFromPrice(initPrice, true);
  
  //8. 添加单边流动性
  const TOTAL_RANGE_INTERVAL = 10;
  const minBinId = activeId;
  const maxBinId = activeId + TOTAL_RANGE_INTERVAL * 2;

  const totalXAmount = new BN(100 * 10 ** tokenXDecimals);
  const totalYAmount = new BN(0);

  const newPosition = new Keypair();
  console.log("🚀 ~ minBinId:", minBinId, "maxBinId:", maxBinId, "totalXAmount:", totalXAmount.toString(), "totalYAmount:", totalYAmount.toString());

  let createPositionTx = await dlmmPool.initializePositionAndAddLiquidityByStrategy({
    positionPubKey: newPosition.publicKey,
    user: keypair.publicKey,
    totalXAmount,
    totalYAmount,
    strategy: {
      maxBinId,
      minBinId,
      strategyType: StrategyType.SpotBalanced,
      singleSidedX: true,
    },
  });
  const blockhashResponse = await connection.getLatestBlockhash();
  const lastValidBlockHeight = blockhashResponse.lastValidBlockHeight - 150;

  createPositionTx = new Transaction({
    feePayer: keypair.publicKey,
    blockhash: blockhashResponse.blockhash,
    lastValidBlockHeight: lastValidBlockHeight,
  }).add(createPositionTx);

  console.log("🚀 ~ createPositionTx:", createPositionTx);
  const priorityFee = 1000000; // Set your desired priority fee in lamports
  createPositionTx
  const txHash = await sendTransactionWithPriorityFee(connection, createPositionTx, [keypair, newPosition], priorityFee);
  console.log("Transaction hash:", txHash);

  return {
    poolAddress: lbPairPubkey,
    tokenX,
    tokenY,
  };
}

async function swap(dlmmPool: DLMM) {
  const tokenXDecimals = 6;
  const swapAmount = new BN(500000 * 10 ** tokenXDecimals);
  // Swap quote
  const swapYtoX = false;
  const binArrays = await dlmmPool.getBinArrayForSwap(swapYtoX);

  const swapQuote = await dlmmPool.swapQuote(swapAmount, swapYtoX, new BN(10), binArrays);

  console.log("🚀 ~ swapQuote:", swapQuote);

  // Swap
  const swapTx = await dlmmPool.swap({
    inToken: dlmmPool.tokenY.publicKey,
    binArraysPubkey: swapQuote.binArraysPubkey,
    inAmount: swapAmount,
    lbPair: dlmmPool.pubkey,
    user: user.publicKey,
    minOutAmount: swapQuote.minOutAmount,
    outToken: dlmmPool.tokenX.publicKey,
  });

  try {
    const swapTxHash = await sendAndConfirmTransaction(connection, swapTx, [
      user,
    ]);
    console.log("🚀 ~ swapTxHash:", swapTxHash);
  } catch (error) {
    console.log("🚀 ~ error:", JSON.parse(JSON.stringify(error)));
  }
}

async function main() {
  const { poolAddress, tokenX, tokenY } = await createPool();
  console.log("Pool created at:", poolAddress.toString());
  console.log("Token X:", tokenX.toString());
  console.log("Token Y:", tokenY.toString());

  // const dlmmPool = await DLMM.create(connection, poolAddress, {
  //   cluster: "mainnet-beta",
  // });
  // await swap(dlmmPool);
}

main();
