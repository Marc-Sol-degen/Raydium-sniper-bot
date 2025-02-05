import {
  BigNumberish,
  Liquidity,
  LIQUIDITY_STATE_LAYOUT_V4,
  LiquidityPoolKeys,
  LiquidityPoolKeysV4,
  LiquidityStateV4,
  MARKET_STATE_LAYOUT_V3,
  MarketStateV3,
  Percent,
  Token,
  TokenAmount,
} from '@raydium-io/raydium-sdk'
import {
  AccountLayout,
  createAssociatedTokenAccountIdempotentInstruction,
  createAssociatedTokenAccountInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddress,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token'
import {
  Keypair,
  Connection,
  PublicKey,
  KeyedAccountInfo,
  TransactionMessage,
  VersionedTransaction,
  TransactionInstruction,
  SystemProgram,
  Transaction,
  ComputeBudgetProgram,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js'
import { getTokenAccounts, RAYDIUM_LIQUIDITY_PROGRAM_ID_V4, OPENBOOK_PROGRAM_ID, createPoolKeys } from './liquidity'
import { checkBalance, deleteConsoleLines, logger } from './utils'
import { getMinimalMarketV3, MinimalMarketLayoutV3 } from './market'
import { MintLayout } from './types'
import bs58 from 'bs58'
import * as fs from 'fs'
import * as path from 'path'
import readline from 'readline'
import {
  CHECK_IF_MINT_IS_RENOUNCED,
  COMMITMENT_LEVEL,
  LOG_LEVEL,
  MAX_SELL_RETRIES,
  PRIVATE_KEY,
  QUOTE_AMOUNT,
  QUOTE_MINT,
  RPC_ENDPOINT,
  RPC_WEBSOCKET_ENDPOINT,
  SNIPE_LIST_REFRESH_INTERVAL,
  USE_SNIPE_LIST,
  MIN_POOL_SIZE,
  MAX_POOL_SIZE,
  ONE_TOKEN_AT_A_TIME,
  PRICE_CHECK_DURATION,
  PRICE_CHECK_INTERVAL,
  TAKE_PROFIT1,
  TAKE_PROFIT2,
  TAKE_PROFIT3,
  STOP_LOSS,
  SELL_SLIPPAGE,
  CHECK_IF_MINT_IS_MUTABLE,
  CHECK_IF_MINT_IS_BURNED,
  JITO_MODE,
  JITO_ALL,
  SELL_AT_TP1,
  SELL_AT_TP2,
  JITO_FEE,
  CHECK_SOCIAL,
  CREATOR_OWNERSHIPT,
  CREATOR_PERCENT
} from './constants'
import { clearMonitor, monitor } from './monitor'
import { BN } from 'bn.js'
import { checkBurn, checkMutable, checkSocial, checkCreatorSupply } from './tokenFilter'
import { bundle } from './executor/jito'
import { execute } from './executor/legacy'
import { jitoWithAxios } from './executor/jitoWithAxios'
import { PoolKeys } from './utils/getPoolKeys'

const monitorConnection = new Connection(RPC_ENDPOINT, {
  wsEndpoint: RPC_WEBSOCKET_ENDPOINT,
  commitment: 'processed'
})

const solanaConnection = new Connection(RPC_ENDPOINT, {
  wsEndpoint: RPC_WEBSOCKET_ENDPOINT,
  commitment: 'confirmed'
})

export interface MinimalTokenAccountData {
  mint: PublicKey
  address: PublicKey
  poolKeys?: LiquidityPoolKeys
  market?: MinimalMarketLayoutV3
}
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
})

const existingLiquidityPools: Set<string> = new Set<string>()
const existingOpenBookMarkets: Set<string> = new Set<string>()
const existingTokenAccounts: Map<string, MinimalTokenAccountData> = new Map<string, MinimalTokenAccountData>()

let wallet: Keypair
let quoteToken: Token
let quoteTokenAssociatedAddress: PublicKey
let quoteAmount: TokenAmount
let quoteMinPoolSizeAmount: TokenAmount
let quoteMaxPoolSizeAmount: TokenAmount
let processingToken: Boolean = false
let poolId: PublicKey
let tokenAccountInCommon: MinimalTokenAccountData | undefined
let accountDataInCommon: LiquidityStateV4 | undefined
let idDealt: string = NATIVE_MINT.toBase58()
let snipeList: string[] = []
let timesChecked: number = 0
let soldSome: boolean = false


async function init(): Promise<void> {
  logger.level = LOG_LEVEL

  // get wallet
  wallet = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY))
  const solBalance = await checkBalance(bs58.decode(PRIVATE_KEY));
  console.log(`Wallet Address: ${wallet.publicKey}`)
  console.log(`SOL balance: ${(solBalance / 10 ** 9).toFixed(3)}SOL`)

  // get quote mint and amount
  switch (QUOTE_MINT) {
    case 'WSOL': {
      quoteToken = Token.WSOL
      quoteAmount = new TokenAmount(Token.WSOL, QUOTE_AMOUNT, false)
      quoteMinPoolSizeAmount = new TokenAmount(quoteToken, MIN_POOL_SIZE, false)
      quoteMaxPoolSizeAmount = new TokenAmount(quoteToken, MAX_POOL_SIZE, false)
      break
    }
    case 'USDC': {
      quoteToken = new Token(
        TOKEN_PROGRAM_ID,
        new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
        6,
        'USDC',
        'USDC',
      )
      quoteAmount = new TokenAmount(quoteToken, QUOTE_AMOUNT, false)
      quoteMinPoolSizeAmount = new TokenAmount(quoteToken, MIN_POOL_SIZE, false)
      quoteMaxPoolSizeAmount = new TokenAmount(quoteToken, MAX_POOL_SIZE, false)
      break
    }
    default: {
      throw new Error(`Unsupported quote mint "${QUOTE_MINT}". Supported values are USDC and WSOL`)
    }
  }

  console.log(`Snipe list: ${USE_SNIPE_LIST}`)
  console.log(`Check token socials: ${CHECK_SOCIAL}`)
  console.log(
    `Min pool size: ${quoteMinPoolSizeAmount.isZero() ? 'false' : quoteMinPoolSizeAmount.toFixed(2)} ${quoteToken.symbol}`,
  )
  console.log(
    `Max pool size: ${quoteMaxPoolSizeAmount.isZero() ? 'false' : quoteMaxPoolSizeAmount.toFixed(4)} ${quoteToken.symbol}`,
  )
  console.log(`Check creator's own percent: ${CREATOR_OWNERSHIPT}`)
  if (CREATOR_OWNERSHIPT) {
    console.log(`Creator's own percent: ${CREATOR_PERCENT}%`)
  }
  console.log("Contract renouncement: ", CHECK_IF_MINT_IS_RENOUNCED)
  console.log("Check Freezable: ", CHECK_IF_MINT_IS_MUTABLE)
  console.log(`One token at a time: ${ONE_TOKEN_AT_A_TIME}`)

  console.log(`Purchase amount: ${quoteAmount.toFixed()} ${quoteToken.symbol}`);
  console.log(`Jito fee: ${(JITO_FEE / LAMPORTS_PER_SOL).toFixed(3)}`)
  console.log(`Take Profit1: +${TAKE_PROFIT1} %, Sell: ${SELL_AT_TP1}%`, `Take Profit2: +${TAKE_PROFIT2} %, Sell: ${SELL_AT_TP2}%`)

  // check existing wallet for associated token account of quote mint
  const tokenAccounts = await getTokenAccounts(solanaConnection, wallet.publicKey, COMMITMENT_LEVEL)

  for (const ta of tokenAccounts) {
    existingTokenAccounts.set(ta.accountInfo.mint.toString(), <MinimalTokenAccountData>{
      mint: ta.accountInfo.mint,
      address: ta.pubkey,
    })
  }

  quoteTokenAssociatedAddress = await getAssociatedTokenAddress(NATIVE_MINT, wallet.publicKey)

  const wsolBalance = await solanaConnection.getBalance(quoteTokenAssociatedAddress)

  console.log(`WSOL Balance: ${wsolBalance}`)
  if (!(!wsolBalance || wsolBalance == 0))
    // await unwrapSol(quoteTokenAssociatedAddress)
    // load tokens to snipe
    loadSnipeList()
}

function saveTokenAccount(mint: PublicKey, accountData: MinimalMarketLayoutV3) {
  const ata = getAssociatedTokenAddressSync(mint, wallet.publicKey)
  const tokenAccount = <MinimalTokenAccountData>{
    address: ata,
    mint: mint,
    market: <MinimalMarketLayoutV3>{
      bids: accountData.bids,
      asks: accountData.asks,
      eventQueue: accountData.eventQueue,
    },
  }
  existingTokenAccounts.set(mint.toString(), tokenAccount)
  return tokenAccount
}

export async function processRaydiumPool(id: PublicKey, poolState: LiquidityStateV4) {
  if (idDealt == id.toString()) return
  idDealt = id.toBase58()
  try {
    const quoteBalance = (await solanaConnection.getBalance(poolState.quoteVault, "processed")) / 10 ** 9

    if (!shouldBuy(poolState.baseMint.toString())) {
      return
    }
    console.log(`Detected a new pool: https://dexscreener.com/solana/${id.toString()}`, formatDate())
    if (!quoteMinPoolSizeAmount.isZero()) {
      console.log(`Processing pool: ${id.toString()} with ${quoteBalance.toFixed(2)} ${quoteToken.symbol} in liquidity`, formatDate())


      if (CREATOR_OWNERSHIPT) {
        const isOwnerShip = await checkCreatorSupply(solanaConnection, poolState.lpMint, poolState.baseMint, CREATOR_PERCENT)
        if (!isOwnerShip) {
          console.log(`Skipping, creator owns more than ${CREATOR_PERCENT}%`);
          return
        }
      }

      // if (poolSize.lt(quoteMinPoolSizeAmount)) {
      if (parseFloat(MIN_POOL_SIZE) > quoteBalance) {
        console.log(`Skipping pool, smaller than ${MIN_POOL_SIZE} ${quoteToken.symbol}`, formatDate())
        console.log(`-------------------------------------- \n`)
        return
      }
    }

    if (!quoteMaxPoolSizeAmount.isZero()) {
      const poolSize = new TokenAmount(quoteToken, poolState.swapQuoteInAmount, true)

      // if (poolSize.gt(quoteMaxPoolSizeAmount)) {
      if (Number(MAX_POOL_SIZE) < quoteBalance) {
        console.log(`Skipping pool, larger than ${MIN_POOL_SIZE} ${quoteToken.symbol}`)
        console.log(
          `Skipping pool, bigger than ${quoteMaxPoolSizeAmount.toFixed()} ${quoteToken.symbol}`,
          `Liquidity Sol Amount: ${poolSize.toFixed()}`,
        )
        console.log(`-------------------------------------- \n`)
        return
      }
    }
  } catch (error) {
    console.log(`Error in getting new pool balance, ${error}`)
  }

  if (CHECK_IF_MINT_IS_RENOUNCED) {
    const mintOption = await checkMintable(poolState.baseMint)

    if (mintOption !== true) {
      console.log('Skipping, owner can mint tokens!', poolState.baseMint)
      return
    }
  }


  if (CHECK_SOCIAL) {
    const isSocial = await checkSocial(solanaConnection, poolState.baseMint, COMMITMENT_LEVEL)
    if (isSocial !== true) {
      console.log('Skipping, token does not have socials', poolState.baseMint)
      return
    }
  }

  if (CHECK_IF_MINT_IS_MUTABLE) {
    const mutable = await checkMutable(solanaConnection, poolState.baseMint)
    if (mutable == true) {
      console.log('Skipping, token is mutable!', poolState.baseMint)
      return
    }
  }

  if (CHECK_IF_MINT_IS_BURNED) {
    const burned = await checkBurn(solanaConnection, poolState.lpMint, COMMITMENT_LEVEL)
    if (burned !== true) {
      console.log('Skipping, token is not burned!', poolState.baseMint)
      return
    }
  }

  if (CREATOR_OWNERSHIPT) {
    const creatorOwn = await checkCreatorSupply(solanaConnection, poolState.lpMint, poolState.baseMint, CREATOR_PERCENT);
    if (!creatorOwn) {
      console.log(`Skipping, creator owned more than ${CREATOR_PERCENT}%`)
      return
    }
  }
  processingToken = true
  console.log('going to buy => ', formatDate())
  await buy(id, poolState)
}

export async function checkMintable(vault: PublicKey): Promise<boolean | undefined> {
  try {
    let { data } = (await solanaConnection.getAccountInfo(vault)) || {}
    if (!data) {
      return
    }
    const deserialize = MintLayout.decode(data)
    return deserialize.mintAuthorityOption === 0
  } catch (e) {
    logger.debug(e)
    console.log(`Failed to check if mint is renounced`, vault)
  }
}

export async function processOpenBookMarket(updatedAccountInfo: KeyedAccountInfo) {
  let accountData: MarketStateV3 | undefined
 
}

async function buy(accountId: PublicKey, accountData: LiquidityStateV4): Promise<void> {
  console.log(`Buy action triggered`)
 
}

export async function sell(mint: PublicKey, amount: BigNumberish, isTp1Sell: boolean = false): Promise<void> {
  // console.log("🚀 ~ sell ~ amount:", amount)
  console.log('Going to sell!')
  
  // if (!isTp1Sell) {

  //   await sell(mint, amount, true)
  //   processingToken = false
  // }
}

function loadSnipeList() {
  
}

function shouldBuy(key: string): boolean {
  return USE_SNIPE_LIST ? snipeList.includes(key) : ONE_TOKEN_AT_A_TIME ? !processingToken : true
}

const runListener = async () => {
  await init()

  trackWallet(solanaConnection)

  console.log('----------------------------------------')
  console.log('Bot is running! Press CTRL + C to stop it.')
  console.log('----------------------------------------')

  if (USE_SNIPE_LIST) {
    setInterval(loadSnipeList, SNIPE_LIST_REFRESH_INTERVAL)
  }
}

const inputAction = async (accountId: PublicKey, mint: PublicKey, amount: BigNumberish) => {
  console.log("\n\n\n==========================================================\n\n\n")
  rl.question('If you want to sell, plz input "sell" and press enter: \n\n', async (data) => {
    const input = data.toString().trim()
    if (input === 'sell') {
      timesChecked = 1000000
    } else {
      console.log('Received input invalid :\t', input)
      inputAction(accountId, mint, amount)
    }
  })
}

const priceMatch = async (amountIn: TokenAmount, poolKeys: LiquidityPoolKeysV4) => {
  try {
    if (PRICE_CHECK_DURATION === 0 || PRICE_CHECK_INTERVAL === 0) {
      return
    }
    let priceMatchAtOne = false
    let priceMatchAtSecond = false
    const timesToCheck = PRICE_CHECK_DURATION / PRICE_CHECK_INTERVAL
    const temp = amountIn.raw.toString()
    const tokenAmount = new BN(temp.substring(0, temp.length - 2))
    console.log("🚀 ~ tokenAmount:", tokenAmount)
    const sellAt1 = tokenAmount.mul(new BN(SELL_AT_TP1)).toString()
    console.log("🚀 ~ sellAt1:", sellAt1)
    const sellAt2 = tokenAmount.mul(new BN(SELL_AT_TP2)).toString()
    console.log("🚀 ~ sellAt2:", sellAt2)
    const slippage = new Percent(SELL_SLIPPAGE, 100)

    const tp1 = Number((Number(QUOTE_AMOUNT) * (100 + TAKE_PROFIT1) / 100).toFixed(4))
    const tp2 = Number((Number(QUOTE_AMOUNT) * (100 + TAKE_PROFIT2) / 100).toFixed(4))
    const tp3 = Number((Number(QUOTE_AMOUNT) * (100 + TAKE_PROFIT2) / 100).toFixed(4))
    const sl = Number((Number(QUOTE_AMOUNT) * (100 - STOP_LOSS) / 100).toFixed(4))
    timesChecked = 0
    do {
      try {
        const poolInfo = await Liquidity.fetchInfo({
          connection: solanaConnection,
          poolKeys,
        })

        const { amountOut } = Liquidity.computeAmountOut({
          poolKeys,
          poolInfo,
          amountIn,
          currencyOut: quoteToken,
          slippage,
        })
        const pnl = (Number(amountOut.toFixed(6)) - Number(QUOTE_AMOUNT)) / Number(QUOTE_AMOUNT) * 100
        console.log("Current Pnl", pnl)
        if (timesChecked > 0) {
          // deleteConsoleLines(1)
        }
        const data = await getPrice()
        if (data) {
          const {
            priceUsd,
            liquidity,
            fdv,
            txns,
            marketCap,
            pairCreatedAt,
            volume_m5,
            volume_h1,
            volume_h6,
            priceChange_m5,
            priceChange_h1,
            priceChange_h6
          } = data
          // console.log(`Take profit1: ${tp1} SOL | Take profit2: ${tp2} SOL  | Stop loss: ${sl} SOL | Buy amount: ${QUOTE_AMOUNT} SOL | Current: ${amountOut.toFixed(4)} SOL | PNL: ${pnl.toFixed(3)}%`)
          console.log(`TP1: ${tp1} | TP2: ${tp2} | SL: ${sl} | Lq: $${(liquidity.usd / 1000).toFixed(3)}K | MC: $${(marketCap / 1000).toFixed(3)}K | Price: $${Number(priceUsd).toFixed(3)} | 5M: ${priceChange_m5}% | 1H: ${priceChange_h1}% | TXs: ${(txns.h1.buys + txns.h1.sells)} | Buy: ${txns.h1.buys} | Sell: ${txns.h1.sells} | Vol: $${(volume_h1 / 1000).toFixed(3)}K`)
        }
        const amountOutNum = Number(amountOut.toFixed(7))
        if (amountOutNum < sl) {
          console.log("Token is on stop loss point, will sell with loss")
          break
        }

        if (amountOutNum > tp1) {
          // if (pnl > TAKE_PROFIT1) {
          if (!priceMatchAtOne) {
            console.log("Token is on first level profit, will sell some and wait for second level higher profit")
            priceMatchAtOne = true
            soldSome = true
            sell(poolKeys.baseMint, sellAt1, true)
            break
          }
        }

        if (amountOutNum < tp1 && priceMatchAtOne) {
          // if (pnl < TAKE_PROFIT1 && priceMatchAtOne) {
          console.log("Token is on first level profit again, will sell with first level")
          sell(poolKeys.baseMint, sellAt2)
          break
        }

        // if (amountOutNum > tp2) {
        if (pnl > TAKE_PROFIT2) {
          console.log("Token is on second level profit, will sell with second level profit")
          priceMatchAtSecond = true;

          sell(poolKeys.baseMint, sellAt1, true)
          break
        }

      } catch (e) {
      } finally {
        timesChecked++
      }
      await sleep(PRICE_CHECK_INTERVAL)
    } while (timesChecked < timesToCheck)
  } catch (error) {
    console.log("Error when setting profit amounts", error)
  }
}

const sleep = async (ms: number) => {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

let bought: string = NATIVE_MINT.toBase58()

const walletChange = async (updatedAccountInfo: KeyedAccountInfo) => {
  const accountData = AccountLayout.decode(updatedAccountInfo.accountInfo!.data)
  if (updatedAccountInfo.accountId.equals(quoteTokenAssociatedAddress)) {
    return
  }
  if (tokenAccountInCommon && accountDataInCommon) {

    if (bought != accountDataInCommon.baseMint.toBase58()) {
      console.log(`\n--------------- bought token successfully ---------------------- \n`)
      console.log(`https://dexscreener.com/solana/${accountDataInCommon.baseMint.toBase58()}`)
      console.log(`PHOTON: https://photon-sol.tinyastro.io/en/lp/${tokenAccountInCommon.poolKeys!.id.toString()}`)
      console.log(`DEXSCREENER: https://dexscreener.com/solana/${tokenAccountInCommon.poolKeys!.id.toString()}`)
      console.log(`JUPITER: https://jup.ag/swap/${accountDataInCommon.baseMint.toBase58()}-SOL`)
      console.log(`BIRDEYE: https://birdeye.so/token/${accountDataInCommon.baseMint.toBase58()}?chain=solana\n\n`)
      bought = accountDataInCommon.baseMint.toBase58()

      const tokenAccount = await getAssociatedTokenAddress(accountData.mint, wallet.publicKey)
      const tokenBalance = await getTokenBalance(tokenAccount)
      if (tokenBalance == "0") {
        console.log(`Detected a new pool, but didn't confirm buy action`)
        return
      }

      const tokenIn = new Token(TOKEN_PROGRAM_ID, tokenAccountInCommon.poolKeys!.baseMint, tokenAccountInCommon.poolKeys!.baseDecimals)
      const tokenAmountIn = new TokenAmount(tokenIn, tokenBalance, true)
      inputAction(updatedAccountInfo.accountId, accountData.mint, tokenBalance)
      console.log("-----Checking token price------")
      await priceMatch(tokenAmountIn, tokenAccountInCommon.poolKeys!)


      const tokenBalanceAfterCheck = await getTokenBalance(tokenAccount)
      if (tokenBalanceAfterCheck == "0") {
        return
      }
      if (soldSome) {
        soldSome = false
        console.log('second sell')
        const _ = await sell(tokenAccountInCommon.poolKeys!.baseMint, tokenBalanceAfterCheck)
      } else {
        console.log('first sell')
        const _ = await sell(tokenAccountInCommon.poolKeys!.baseMint, accountData.amount)
      }
    }
  }
}

const getTokenBalance = async (tokenAccount: PublicKey) => {
  let tokenBalance = "0"
  let index = 0
  do {
    try {
      const tokenBal = (await solanaConnection.getTokenAccountBalance(tokenAccount, 'processed')).value
      const uiAmount = tokenBal.uiAmount
      if (index > 10) {
        break
      }
      if (uiAmount && uiAmount > 0) {
        tokenBalance = tokenBal.amount
        console.log(`Token balance is ${uiAmount}`)
        break
      }
      await sleep(1000)
      index++
    } catch (error) {
      await sleep(500)
    }
  } while (true);
  return tokenBalance
}




async function trackWallet(connection: Connection): Promise<void> {

}


const getPrice = async () => {
  if (!poolId) return
  try {
    // let poolId = new PublicKey("13bqEPVQewKAVbprEZVgqkmaCgSMsdBN9up5xfvLtXDV")
    const res = await fetch(`https://api.dexscreener.com/latest/dex/pairs/solana/${poolId?.toBase58()}`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      }
    })
    const data = await res.clone().json()
    if (!data.pair) {
      return
    }
    // console.log("🚀 ~ getprice ~ data:", data)
    // console.log("price data => ", data.pair.priceUsd)
    const { priceUsd, priceNative, volume, priceChange, liquidity, fdv, marketCap, pairCreatedAt, txns } = data.pair
    const { m5: volume_m5, h1: volume_h1, h6: volume_h6 } = volume
    const { m5: priceChange_m5, h1: priceChange_h1, h6: priceChange_h6 } = priceChange
    // console.log(`Lq: $${(liquidity.usd / 1000).toFixed(3)}K | MC: $${(marketCap / 1000).toFixed(3)}K | Price: $${Number(priceUsd).toFixed(3)} | 5M: ${priceChange_m5}% | 1H: ${priceChange_h1}% | TXs: ${txns.h1.buys + txns.h1.sells} | Buy: ${txns.h1.buys} | Sell: ${txns.h1.sells} | Vol: $${(volume_h1 / 1000).toFixed(3)}K`)
    // console.log(`${priceUsd} ${priceNative} ${liquidity.usd} ${fdv} ${marketCap} ${pairCreatedAt} ${volume_m5} ${volume_h1} ${volume_h6} ${priceChange_m5} ${priceChange_h1} ${priceChange_h6}`)
    return {
      priceUsd,
      priceNative,
      liquidity,
      fdv,
      txns,
      marketCap,
      pairCreatedAt,
      volume_m5,
      volume_h1,
      volume_h6,
      priceChange_m5,
      priceChange_h1,
      priceChange_h6
    }
  } catch (e) {
    console.log("error in fetching price of pool", e)
    return
  }
}

export function formatDate() {
  const options: any = {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZone: 'UTC',
    timeZoneName: 'short'
  };

  const now = new Date();
  return now.toLocaleString('en-US', options);
}

function convertTimestampToDate(timestamp: number): string {
  // Convert the timestamp to milliseconds
  const date = new Date(timestamp * 1000);


  const options: any = {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZone: 'UTC',
    timeZoneName: 'short'
  };

  // Format the date
  return date.toLocaleString('en-US', options); // Returns the date in UTC in ISO 8601 format
}

runListener()
// getPrice()


