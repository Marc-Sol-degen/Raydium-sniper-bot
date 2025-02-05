import { Commitment, Connection, PublicKey } from '@solana/web3.js';
import { getPdaMetadataKey } from '@raydium-io/raydium-sdk';
import { MetadataAccountData, MetadataAccountDataArgs, getMetadataAccountDataSerializer } from '@metaplex-foundation/mpl-token-metadata';
import { getAssociatedTokenAddress, getAssociatedTokenAddressSync } from '@solana/spl-token';

export const checkBurn = async (connection: Connection, lpMint: PublicKey, commitment: Commitment) => {
  try {
    const amount = await connection.getTokenSupply(lpMint, commitment);
    const burned = amount.value.uiAmount === 0;
    return burned
  } catch (error) {
    return false
  }
}

export const checkMutable = async (connection: Connection, baseMint: PublicKey,) => {
  try {
    const metadataPDA = getPdaMetadataKey(baseMint);
    const metadataAccount = await connection.getAccountInfo(metadataPDA.publicKey);
    if (!metadataAccount?.data) {
      return { ok: false, message: 'Mutable -> Failed to fetch account data' };
    }
    const serializer = getMetadataAccountDataSerializer()
    const deserialize = serializer.deserialize(metadataAccount.data);
    const mutable = deserialize[0].isMutable;

    return !mutable
  } catch (e: any) {
    return false
  }
}



export const checkSocial = async (connection: Connection, baseMint: PublicKey, commitment: Commitment) => {
  try {
    const serializer = getMetadataAccountDataSerializer()
    const metadataPDA = getPdaMetadataKey(baseMint);
    const metadataAccount = await connection.getAccountInfo(metadataPDA.publicKey, commitment);
    if (!metadataAccount?.data) {
      return { ok: false, message: 'Mutable -> Failed to fetch account data' };
    }

    const deserialize = serializer.deserialize(metadataAccount.data);
    const social = await hasSocials(deserialize[0])
    return social
  } catch (error) {
    return false
  }
}

async function hasSocials(metadata: MetadataAccountData) {
  const response = await fetch(metadata.uri);
  const data = await response.json();
  return Object.values(data?.extensions ?? {}).some((value: any) => value !== null && value.length > 0);
}

export const checkCreatorSupply = async (connection: Connection, lp: PublicKey, mint: PublicKey, percent: number) => {
  try {
    const signatures = await connection.getSignaturesForAddress(lp);
    const latestSignature = signatures[0].signature;
    const signers = await getSignersFromParsedTransaction(latestSignature, connection);

    const creator = signers[0].pubkey;
    const supply = await connection.getTokenSupply(mint);

    // Fetch token accounts associated with the wallet
    const tokenAccounts = await connection.getTokenAccountsByOwner(creator, {
      mint: mint,
    });

    // If no token accounts are found
    if (tokenAccounts.value.length === 0) {
      console.log("No token accounts found for this wallet and token mint.");
      return false;
    }

    // Get the balance of the first token account
    const tokenAccount = tokenAccounts.value[0].pubkey;
    const creatorAmount = await connection.getTokenAccountBalance(tokenAccount);

    if (!supply.value.uiAmount) return false

    if (creatorAmount.value.uiAmount && creatorAmount.value.uiAmount === 0) return true;

    const ownPercent = (creatorAmount.value.uiAmount! / supply.value.uiAmount) * 100;

    if (ownPercent > percent) {
      console.log(`Creator owns more than ${percent} % `)
      return false
    }
    return true
  } catch (error) {
    console.log('checking creator error => ', error)
    return false
  }
}

async function getSignersFromParsedTransaction(txSignature: string, connection: Connection) {
  const parsedTransaction = await connection.getParsedTransaction(txSignature, {
    maxSupportedTransactionVersion: 0,
    commitment: 'confirmed'
  });
  if (!parsedTransaction) {
    throw new Error("Transaction not found");
  }

  const signers: { pubkey: PublicKey, signature: string | null }[] = [];
  const { signatures, message } = parsedTransaction.transaction;
  const accountKeys = message.accountKeys;

  accountKeys.forEach((account, index) => {
    if (account.signer) {
      signers.push({
        pubkey: account.pubkey,
        signature: signatures[index] || null, // Signature might be null for partial signing
      });
    }
  });

  return signers;
}