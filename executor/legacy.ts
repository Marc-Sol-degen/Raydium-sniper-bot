import { Connection, VersionedTransaction } from "@solana/web3.js";
import { COMMITMENT_LEVEL, RPC_ENDPOINT, RPC_WEBSOCKET_ENDPOINT } from "../constants";
import { logger } from "../utils";


interface Blockhash {
  blockhash: string;
  lastValidBlockHeight: number;
}

export const execute = async (transaction: VersionedTransaction, latestBlockhash: Blockhash) => {
  const solanaConnection = new Connection(RPC_ENDPOINT, {
    wsEndpoint: RPC_WEBSOCKET_ENDPOINT,
  })

  console.log(await solanaConnection.simulateTransaction(transaction));

  const signature = await solanaConnection.sendRawTransaction(transaction.serialize(), {
    preflightCommitment: COMMITMENT_LEVEL,
    skipPreflight: false,
  })

  logger.debug({ signature }, 'Confirming transaction...');

  const confirmation = await solanaConnection.confirmTransaction(
    {
      signature,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
      blockhash: latestBlockhash.blockhash,
    },
    COMMITMENT_LEVEL,
  );

  if(confirmation.value.err) {
    console.log("Confrimtaion error")
    return
  } else {
    console.log("https://solscan.io/tx/", signature)
  }
}
