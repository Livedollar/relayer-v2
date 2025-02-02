import { getProvider, Wallet, winston, convertFromWei, groupObjectCountsByProp, Contract } from "../../utils";
import { L2ToL1MessageStatus, L2TransactionReceipt, getL2Network, IL2ToL1MessageWriter } from "@arbitrum/sdk";
import { TokensBridged } from "../../interfaces";
import { HubPoolClient } from "../../clients";
import { Multicall2Call, Withdrawal } from "..";

const CHAIN_ID = 42161;

export async function multicallArbitrumFinalizations(
  tokensBridged: TokensBridged[],
  hubSigner: Wallet,
  hubPoolClient: HubPoolClient,
  logger: winston.Logger
): Promise<{ callData: Multicall2Call[]; withdrawals: Withdrawal[] }> {
  const finalizableMessages = await getFinalizableMessages(logger, tokensBridged, hubSigner);
  const callData = await Promise.all(finalizableMessages.map((message) => finalizeArbitrum(message.message)));
  const withdrawals = finalizableMessages.map((message) => {
    const l1TokenCounterpart = hubPoolClient.getL1TokenCounterpartAtBlock(
      CHAIN_ID,
      message.info.l2TokenAddress,
      hubPoolClient.latestBlockNumber
    );
    const l1TokenInfo = hubPoolClient.getTokenInfo(1, l1TokenCounterpart);
    const amountFromWei = convertFromWei(message.info.amountToReturn.toString(), l1TokenInfo.decimals);
    return {
      l2ChainId: CHAIN_ID,
      l1TokenSymbol: l1TokenInfo.symbol,
      amount: amountFromWei,
    };
  });
  return {
    callData,
    withdrawals,
  };
}

export async function finalizeArbitrum(message: IL2ToL1MessageWriter): Promise<Multicall2Call> {
  const l2Provider = getProvider(CHAIN_ID);
  const proof = await message.getOutboxProof(l2Provider);
  const outbox = new Contract((await getL2Network(l2Provider)).ethBridge.outbox, outboxAbi);
  const eventData = (message as any).nitroWriter.event; // nitroWriter is a private property on the
  // L2ToL1MessageWriter class, which we need to form the calldata so unfortunately we must cast to `any`.
  const callData = await outbox.populateTransaction.executeTransaction(
    proof,
    eventData.position,
    eventData.caller,
    eventData.destination,
    eventData.arbBlockNum,
    eventData.ethBlockNum,
    eventData.timestamp,
    eventData.callvalue,
    eventData.data,
    {}
  );
  return {
    callData: callData.data,
    target: callData.to,
  };
}

export async function getFinalizableMessages(logger: winston.Logger, tokensBridged: TokensBridged[], l1Signer: Wallet) {
  const allMessagesWithStatuses = await getAllMessageStatuses(tokensBridged, logger, l1Signer);
  const statusesGrouped = groupObjectCountsByProp(
    allMessagesWithStatuses,
    (message: { status: string }) => message.status
  );
  logger.debug({
    at: "ArbitrumFinalizer",
    message: "Arbitrum outbox message statuses",
    statusesGrouped,
  });
  return allMessagesWithStatuses.filter((x) => x.status === L2ToL1MessageStatus[L2ToL1MessageStatus.CONFIRMED]);
}

export async function getAllMessageStatuses(
  tokensBridged: TokensBridged[],
  logger: winston.Logger,
  mainnetSigner: Wallet
) {
  // For each token bridge event, store a unique log index for the event within the arbitrum transaction hash.
  // This is important for bridge transactions containing multiple events.
  const uniqueTokenhashes = {};
  const logIndexesForMessage = [];
  for (const event of tokensBridged) {
    uniqueTokenhashes[event.transactionHash] = uniqueTokenhashes[event.transactionHash] ?? 0;
    const logIndex = uniqueTokenhashes[event.transactionHash];
    logIndexesForMessage.push(logIndex);
    uniqueTokenhashes[event.transactionHash] += 1;
  }
  return (
    await Promise.all(
      tokensBridged.map((e, i) => getMessageOutboxStatusAndProof(logger, e, mainnetSigner, logIndexesForMessage[i]))
    )
  )
    .map((result, i) => {
      return {
        ...result,
        info: tokensBridged[i],
      };
    })
    .filter((result) => result.message !== undefined);
}
export async function getMessageOutboxStatusAndProof(
  logger: winston.Logger,
  event: TokensBridged,
  l1Signer: Wallet,
  logIndex: number
): Promise<{
  message: IL2ToL1MessageWriter;
  status: string;
}> {
  const l2Provider = getProvider(CHAIN_ID);
  const receipt = await l2Provider.getTransactionReceipt(event.transactionHash);
  const l2Receipt = new L2TransactionReceipt(receipt);

  try {
    const l2ToL1Messages = await l2Receipt.getL2ToL1Messages(l1Signer, l2Provider);
    if (l2ToL1Messages.length === 0 || l2ToL1Messages.length - 1 < logIndex) {
      const error = new Error(`No outgoing messages found in transaction:${event.transactionHash}`);
      logger.warn({
        at: "ArbitrumFinalizer",
        message: "Arbitrum transaction that emitted TokensBridged event unexpectedly contains 0 L2-to-L1 messages 🤢!",
        logIndex,
        l2ToL1Messages: l2ToL1Messages.length,
        txnHash: event.transactionHash,
        reason: error.stack || error.message || error.toString(),
        notificationPath: "across-error",
      });
      throw error;
    }
    const l2Message = l2ToL1Messages[logIndex];

    // Check if already executed or unconfirmed (i.e. not yet available to be executed on L1 following dispute
    // window)
    const outboxMessageExecutionStatus = await l2Message.status(l2Provider);
    if (outboxMessageExecutionStatus === L2ToL1MessageStatus.EXECUTED) {
      return {
        message: l2Message,
        status: L2ToL1MessageStatus[L2ToL1MessageStatus.EXECUTED],
      };
    }
    if (outboxMessageExecutionStatus !== L2ToL1MessageStatus.CONFIRMED) {
      return {
        message: l2Message,
        status: L2ToL1MessageStatus[L2ToL1MessageStatus.UNCONFIRMED],
      };
    }

    // Now that its confirmed and not executed, we can execute our
    // message in its outbox entry.
    return {
      message: l2Message,
      status: L2ToL1MessageStatus[outboxMessageExecutionStatus],
    };
  } catch (error) {
    // Likely L1 message hasn't been included in an arbitrum batch yet, so ignore it for now.
    return {
      message: undefined,
      status: L2ToL1MessageStatus[L2ToL1MessageStatus.UNCONFIRMED],
    };
  }
}

const outboxAbi = [
  {
    inputs: [
      {
        internalType: "bytes32[]",
        name: "proof",
        type: "bytes32[]",
      },
      {
        internalType: "uint256",
        name: "index",
        type: "uint256",
      },
      {
        internalType: "address",
        name: "l2Sender",
        type: "address",
      },
      {
        internalType: "address",
        name: "to",
        type: "address",
      },
      {
        internalType: "uint256",
        name: "l2Block",
        type: "uint256",
      },
      {
        internalType: "uint256",
        name: "l1Block",
        type: "uint256",
      },
      {
        internalType: "uint256",
        name: "l2Timestamp",
        type: "uint256",
      },
      {
        internalType: "uint256",
        name: "value",
        type: "uint256",
      },
      {
        internalType: "bytes",
        name: "data",
        type: "bytes",
      },
    ],
    name: "executeTransaction",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
];
