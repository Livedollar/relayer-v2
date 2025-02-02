import { Provider } from "@ethersproject/abstract-provider";
import * as constants from "../common/Constants";
import { assert, BigNumber, formatFeePct, max, winston, toBNWei, toBN, assign } from "../utils";
import { HubPoolClient } from ".";
import { Deposit, L1Token, SpokePoolClientsByChain } from "../interfaces";
import { priceClient, relayFeeCalculator } from "@across-protocol/sdk-v2";
import { constants as sdkConstants } from "@across-protocol/sdk-v2";
const { TOKEN_SYMBOLS_MAP, CHAIN_IDs } = sdkConstants;

// We use wrapped ERC-20 versions instead of the native tokens such as ETH, MATIC for ease of computing prices.
// @todo: These don't belong in the ProfitClient; they should be relocated.
export const MATIC = TOKEN_SYMBOLS_MAP.MATIC.addresses[CHAIN_IDs.MAINNET];
export const USDC = TOKEN_SYMBOLS_MAP.USDC.addresses[CHAIN_IDs.MAINNET];
export const WBTC = TOKEN_SYMBOLS_MAP.WBTC.addresses[CHAIN_IDs.MAINNET];
export const WETH = TOKEN_SYMBOLS_MAP.WETH.addresses[CHAIN_IDs.MAINNET];

// note: All FillProfit BigNumbers are scaled to 18 decimals unless specified otherwise.
export type FillProfit = {
  grossRelayerFeePct: BigNumber; // Max of relayerFeePct and newRelayerFeePct from Deposit.
  tokenPriceUsd: BigNumber; // Resolved USD price of the bridged token.
  fillAmountUsd: BigNumber; // Amount of the bridged token being filled.
  grossRelayerFeeUsd: BigNumber; // USD value of the relay fee paid by the user.
  nativeGasCost: BigNumber; // Cost of completing the fill in the native gas token.
  gasMultiplier: BigNumber; // Multiplier to apply to nativeGasCost as padding or discount
  gasPriceUsd: BigNumber; // Price paid per unit of gas in USD.
  gasCostUsd: BigNumber; // Estimated cost of completing the fill in USD.
  relayerCapitalUsd: BigNumber; // Amount to be sent by the relayer in USD.
  netRelayerFeePct: BigNumber; // Relayer fee after gas costs as a portion of relayerCapitalUsd.
  netRelayerFeeUsd: BigNumber; // Relayer fee in USD after paying for gas costs.
  fillProfitable: boolean; // Fill profitability indicator.
};

export const GAS_TOKEN_BY_CHAIN_ID: { [chainId: number]: string } = {
  1: WETH,
  10: WETH,
  137: MATIC,
  288: WETH,
  42161: WETH,
};
// TODO: Make this dynamic once we support chains with gas tokens that have different decimals.
const GAS_TOKEN_DECIMALS = 18;

// Note: the type here assumes that all of these classes take the same constructor parameters.
const QUERY_HANDLERS: {
  [chainId: number]: new (
    ...args: ConstructorParameters<typeof relayFeeCalculator.EthereumQueries>
  ) => relayFeeCalculator.QueryInterface;
} = {
  1: relayFeeCalculator.EthereumQueries,
  10: relayFeeCalculator.OptimismQueries,
  137: relayFeeCalculator.PolygonQueries,
  288: relayFeeCalculator.BobaQueries,
  42161: relayFeeCalculator.ArbitrumQueries,
};

const { PriceClient } = priceClient;
const { acrossApi, coingecko, defiLlama } = priceClient.adapters;

export class ProfitClient {
  private readonly priceClient;
  protected tokenPrices: { [l1Token: string]: BigNumber } = {};
  private unprofitableFills: { [chainId: number]: { deposit: Deposit; fillAmount: BigNumber }[] } = {};

  // Track total gas costs of a relay on each chain.
  protected totalGasCosts: { [chainId: number]: BigNumber } = {};

  // Queries needed to fetch relay gas costs.
  private relayerFeeQueries: { [chainId: number]: relayFeeCalculator.QueryInterface } = {};

  // @todo: Consolidate this set of args before it grows legs and runs away from us.
  constructor(
    readonly logger: winston.Logger,
    readonly hubPoolClient: HubPoolClient,
    spokePoolClients: SpokePoolClientsByChain,
    readonly ignoreProfitability: boolean,
    readonly enabledChainIds: number[],
    readonly minRelayerFeePct: BigNumber = toBNWei(constants.RELAYER_MIN_FEE_PCT),
    readonly debugProfitability: boolean = false,
    protected gasMultiplier: BigNumber = toBNWei(1)
  ) {
    // Require 1% <= gasMultiplier <= 400%
    assert(
      this.gasMultiplier.gte(toBNWei("0.01")) && this.gasMultiplier.lte(toBNWei(4)),
      `Gas multiplier out of range (${this.gasMultiplier})`
    );

    this.priceClient = new PriceClient(logger, [
      new acrossApi.PriceFeed(),
      new coingecko.PriceFeed({ apiKey: process.env.COINGECKO_PRO_API_KEY }),
      new defiLlama.PriceFeed(),
    ]);

    for (const chainId of this.enabledChainIds) {
      this.relayerFeeQueries[chainId] = this.constructRelayerFeeQuery(
        chainId,
        spokePoolClients[chainId].spokePool.provider
      );
    }
  }

  getAllPrices(): { [address: string]: BigNumber } {
    return this.tokenPrices;
  }

  getPriceOfToken(token: string): BigNumber {
    // Warn on this initially, and move to an assert() once any latent issues are resolved.
    // assert(this.tokenPrices[token] !== undefined, `Token ${token} not in price list.`);
    if (this.tokenPrices[token] === undefined) {
      this.logger.warn({ at: "ProfitClient#getPriceOfToken", message: `Token ${token} not in price list.` });
      return toBN(0);
    }
    return this.tokenPrices[token];
  }

  getTotalGasCost(chainId: number): BigNumber {
    // TODO: Figure out where the mysterious BigNumber -> string conversion happens.
    return this.totalGasCosts[chainId] ? toBN(this.totalGasCosts[chainId]) : toBN(0);
  }

  // Estimate the gas cost of filling this relay.
  estimateFillCost(chainId: number): {
    nativeGasCost: BigNumber;
    gasPriceUsd: BigNumber;
    gasCostUsd: BigNumber;
  } {
    const gasPriceUsd = this.getPriceOfToken(GAS_TOKEN_BY_CHAIN_ID[chainId]);
    const nativeGasCost = this.getTotalGasCost(chainId); // gas cost in native token

    if (gasPriceUsd.lte(0) || nativeGasCost.lte(0)) {
      const err = gasPriceUsd.lte(0) ? "gas price" : "gas consumption";
      throw new Error(`Unable to compute gas cost (${err} unknown)`);
    }

    // this._gasMultiplier is scaled to 18 decimals
    const gasCostUsd = nativeGasCost
      .mul(this.gasMultiplier)
      .mul(gasPriceUsd)
      .div(toBNWei(1))
      .div(toBN(10).pow(GAS_TOKEN_DECIMALS));

    return {
      nativeGasCost,
      gasPriceUsd,
      gasCostUsd,
    };
  }

  getUnprofitableFills(): { [chainId: number]: { deposit: Deposit; fillAmount: BigNumber }[] } {
    return this.unprofitableFills;
  }

  clearUnprofitableFills(): void {
    this.unprofitableFills = {};
  }

  appliedRelayerFeePct(deposit: Deposit): BigNumber {
    // Return the maximum available relayerFeePct (max of Deposit and any SpeedUp).
    return max(toBN(deposit.relayerFeePct), deposit.newRelayerFeePct ? toBN(deposit.newRelayerFeePct) : toBN(0));
  }

  calculateFillProfitability(deposit: Deposit, fillAmount: BigNumber, l1Token?: L1Token): FillProfit {
    assert(fillAmount.gt(0), `Unexpected fillAmount: ${fillAmount}`);
    assert(
      Object.keys(GAS_TOKEN_BY_CHAIN_ID).includes(deposit.destinationChainId.toString()),
      `Unsupported destination chain ID: ${deposit.destinationChainId}`
    );

    l1Token ??= this.hubPoolClient.getTokenInfoForDeposit(deposit);
    assert(l1Token !== undefined, `No L1 token found for deposit ${JSON.stringify(deposit)}`);
    const tokenPriceUsd = this.getPriceOfToken(l1Token.address);
    if (tokenPriceUsd.lte(0)) throw new Error(`Unable to determine ${l1Token.symbol} L1 token price`);

    // Normalise to 18 decimals.
    const scaledFillAmount =
      l1Token.decimals === 18 ? fillAmount : toBN(fillAmount).mul(toBNWei(1, 18 - l1Token.decimals));

    const grossRelayerFeePct = this.appliedRelayerFeePct(deposit);

    // Calculate relayer fee and capital outlay in relay token terms.
    const grossRelayerFee = grossRelayerFeePct.mul(scaledFillAmount).div(toBNWei(1));
    const relayerCapital = scaledFillAmount.sub(grossRelayerFee);

    // Normalise to USD terms.
    const fillAmountUsd = scaledFillAmount.mul(tokenPriceUsd).div(toBNWei(1));
    const grossRelayerFeeUsd = grossRelayerFee.mul(tokenPriceUsd).div(toBNWei(1));
    const relayerCapitalUsd = relayerCapital.mul(tokenPriceUsd).div(toBNWei(1));

    // Estimate the gas cost of filling this relay.
    const { nativeGasCost, gasPriceUsd, gasCostUsd } = this.estimateFillCost(deposit.destinationChainId);

    // Determine profitability.
    const netRelayerFeeUsd = grossRelayerFeeUsd.sub(gasCostUsd);
    const netRelayerFeePct = netRelayerFeeUsd.mul(toBNWei(1)).div(relayerCapitalUsd);

    // If token price or gas cost is unknown, assume the relay is unprofitable.
    const fillProfitable = tokenPriceUsd.gt(0) && gasCostUsd.gt(0) && netRelayerFeePct.gte(this.minRelayerFeePct);

    return {
      grossRelayerFeePct,
      tokenPriceUsd,
      fillAmountUsd,
      grossRelayerFeeUsd,
      nativeGasCost,
      gasMultiplier: this.gasMultiplier,
      gasPriceUsd,
      gasCostUsd,
      relayerCapitalUsd,
      netRelayerFeePct,
      netRelayerFeeUsd,
      fillProfitable,
    };
  }

  // Return USD amount of fill amount for deposited token, should always return in wei as the units.
  getFillAmountInUsd(deposit: Deposit, fillAmount: BigNumber): BigNumber {
    const l1TokenInfo = this.hubPoolClient.getTokenInfoForDeposit(deposit);
    if (!l1TokenInfo)
      throw new Error(
        `ProfitClient::isFillProfitable missing l1TokenInfo for deposit with origin token: ${deposit.originToken}`
      );
    const tokenPriceInUsd = this.getPriceOfToken(l1TokenInfo.address);
    return fillAmount.mul(tokenPriceInUsd).div(toBN(10).pow(l1TokenInfo.decimals));
  }

  isFillProfitable(deposit: Deposit, fillAmount: BigNumber, l1Token?: L1Token): boolean {
    let fill: FillProfit;

    try {
      fill = this.calculateFillProfitability(deposit, fillAmount, l1Token);
    } catch (err) {
      this.logger.debug({
        at: "ProfitClient#isFillProfitable",
        message: `Unable to determine fill profitability (${err}).`,
        deposit,
        fillAmount,
      });
      return this.ignoreProfitability && this.appliedRelayerFeePct(deposit).gte(this.minRelayerFeePct);
    }

    if (!fill.fillProfitable || this.debugProfitability) {
      const { depositId, originChainId } = deposit;
      const profitable = fill.fillProfitable ? "profitable" : "unprofitable";
      this.logger.debug({
        at: "ProfitClient#isFillProfitable",
        message: `${l1Token.symbol} deposit ${depositId} on chain ${originChainId} is ${profitable}`,
        deposit,
        l1Token,
        fillAmount,
        fillAmountUsd: fill.fillAmountUsd,
        grossRelayerFeePct: `${formatFeePct(fill.grossRelayerFeePct)}%`,
        nativeGasCost: fill.nativeGasCost,
        gasMultiplier: `${formatFeePct(fill.gasMultiplier)}%`,
        gasPriceUsd: fill.gasPriceUsd,
        relayerCapitalUsd: `${fill.relayerCapitalUsd}`,
        grossRelayerFeeUsd: fill.grossRelayerFeeUsd,
        gasCostUsd: fill.gasCostUsd,
        netRelayerFeeUsd: `${fill.netRelayerFeeUsd}`,
        netRelayerFeePct: `${formatFeePct(fill.netRelayerFeePct)}%`,
        minRelayerFeePct: `${formatFeePct(this.minRelayerFeePct)}%`,
        fillProfitable: fill.fillProfitable,
      });
    }

    // If profitability is disabled, ensure _at least_ that the relayerFeePct >= minRelayerFeePct.
    // This is a temporary measure and can hopefully be removed (together with ignoreProfitability) in future.
    return fill.fillProfitable || (this.ignoreProfitability && fill.grossRelayerFeePct.gte(this.minRelayerFeePct));
  }

  captureUnprofitableFill(deposit: Deposit, fillAmount: BigNumber): void {
    this.logger.debug({ at: "ProfitClient", message: "Handling unprofitable fill", deposit, fillAmount });
    assign(this.unprofitableFills, [deposit.originChainId], [{ deposit, fillAmount }]);
  }

  anyCapturedUnprofitableFills(): boolean {
    return Object.keys(this.unprofitableFills).length != 0;
  }

  async update(): Promise<void> {
    await Promise.all([this.updateTokenPrices(), this.updateGasCosts()]);
  }

  protected async updateTokenPrices(): Promise<void> {
    // Generate list of tokens to retrieve.
    const newTokens: string[] = [];
    const l1Tokens: { [k: string]: L1Token } = Object.fromEntries(
      this.hubPoolClient.getL1Tokens().map((token) => [token["address"], token])
    );

    // Also include MATIC in the price queries as we need it for gas cost calculation.
    l1Tokens[MATIC] = {
      address: MATIC,
      symbol: "MATIC",
      decimals: 18,
    };

    this.logger.debug({ at: "ProfitClient", message: "Updating Profit client", tokens: Object.values(l1Tokens) });

    // Pre-populate any new addresses.
    Object.values(l1Tokens).forEach((token: L1Token) => {
      const { address, symbol } = token;
      if (this.tokenPrices[address] === undefined) {
        this.tokenPrices[address] = toBN(0);
        newTokens.push(symbol);
      }
    });

    if (newTokens.length > 0) {
      this.logger.debug({
        at: "ProfitClient",
        message: "Initialised tokens to price 0.",
        tokens: newTokens.join(", "),
      });
    }

    try {
      const tokenPrices = await this.priceClient.getPricesByAddress(Object.keys(l1Tokens), "usd");
      tokenPrices.forEach((tokenPrice) => {
        this.tokenPrices[tokenPrice.address] = toBNWei(tokenPrice.price);
      });
      this.logger.debug({ at: "ProfitClient", message: "Updated token prices", tokenPrices: this.tokenPrices });
    } catch (err) {
      const errMsg = `Failed to update token prices (${err})`;
      let mrkdwn = `${errMsg}:\n`;
      Object.entries(l1Tokens).forEach(([address, l1Token]) => {
        mrkdwn += `- Using last known ${l1Token.symbol} price of ${this.getPriceOfToken(l1Token.address)}.\n`;
      });
      this.logger.warn({ at: "ProfitClient", message: "Could not fetch all token prices 💳", mrkdwn });
      if (!this.ignoreProfitability) throw new Error(errMsg);
    }
  }

  private async updateGasCosts(): Promise<void> {
    // Pre-fetch total gas costs for relays on enabled chains.
    const gasCosts = await Promise.all(
      this.enabledChainIds.map((chainId) => this.relayerFeeQueries[chainId].getGasCosts())
    );
    for (let i = 0; i < this.enabledChainIds.length; i++) {
      // An extra toBN cast is needed as the provider returns a different BigNumber type.
      this.totalGasCosts[this.enabledChainIds[i]] = toBN(gasCosts[i]);
    }

    this.logger.debug({
      at: "ProfitClient",
      message: "Updated gas cost",
      enabledChainIds: this.enabledChainIds,
      totalGasCosts: this.totalGasCosts,
    });
  }

  private constructRelayerFeeQuery(chainId: number, provider: Provider): relayFeeCalculator.QueryInterface {
    // Fallback to Coingecko's free API for now.
    // TODO: Add support for Coingecko Pro.
    const coingeckoProApiKey = undefined;
    // TODO: Set this once we figure out gas markup on the API side.
    const gasMarkup = 0;
    return new QUERY_HANDLERS[chainId](
      provider,
      undefined,
      undefined,
      undefined,
      undefined,
      coingeckoProApiKey,
      this.logger,
      gasMarkup
    );
  }
}
