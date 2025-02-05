import { PublicKey } from "@solana/web3.js"
import { logger } from "./utils"

let monitorTimer: NodeJS.Timeout

export const monitor = async (poolId: PublicKey) => {
  monitorTimer = setInterval(() => {
    (async () => {
      try {
        const res = await fetch(`https://api.dexscreener.com/latest/dex/pairs/solana/${poolId?.toBase58()}`, {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json'
          }
        })
        const data = await res.clone().json()
        if (data.pair)
          console.log(`Token price : ${data.pair.priceNative}SOL / ${data.pair.priceUsd}USD  <<<=====>>> Liquidity: ${data.pair.liquidity.usd}USD / ${data.pair.liquidity.quote}SOL`)
      } catch (e) {
        // console.log("error in fetching price of pool", e)
      }
    })()
  }, 2000)
}


export const clearMonitor = () => {
  clearInterval(monitorTimer)
}