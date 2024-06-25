import type {
  AssetId as AssetIdType,
  CostModels,
  Credential,
  DatumHash,
  PlutusData,
  ProtocolParameters,
  Redeemers,
  TokenMap,
  Transaction,
} from "@blaze-cardano/core";
import {
  Address,
  AddressType,
  AssetId,
  TransactionId,
  TransactionInput,
  TransactionOutput,
  TransactionUnspentOutput,
  Value,
} from "@blaze-cardano/core";
import { PlutusLanguageVersion } from "@blaze-cardano/core";
import type { Provider } from "./types";

export class Blockfrost implements Provider {
  url: string;
  private projectId: string;

  constructor({
    network,
    projectId,
  }: {
    network:
      | "cardano-preview"
      | "cardano-preprod"
      | "cardano-mainnet"
      | "cardano-sanchonet";
    projectId: string;
  }) {
    this.url = `https://${network}.blockfrost.io/api/v0/`;
    this.projectId = projectId;
  }

  headers() {
    return { project_id: this.projectId };
  }

  /**
   * This method fetches the protocol parameters from the Blockfrost API.
   * It constructs the query URL, sends a GET request with the appropriate headers, and processes the response.
   * The response is parsed into a ProtocolParameters object, which is then returned.
   * If the response is not in the expected format, an error is thrown.
   * @returns A Promise that resolves to a ProtocolParameters object.
   */
  getParameters(): Promise<ProtocolParameters> {
    const query = "epochs/latest/parameters";
    return fetch(`${this.url}${query}`, { headers: this.headers() })
      .then((resp) => resp.json())
      .then((json) => {
        if (json) {
          const response =
            json as BlockfrostResponse<BlockfrostProtocolParametersResponse>;
          if ("message" in response) {
            throw new Error(
              `getParameters: Blockfrost threw "${response.message}"`,
            );
          }
          const costModels: CostModels = new Map();
          for (const cm of Object.keys(
            response.cost_models,
          ) as BlockfrostLanguageVersions[]) {
            const costModel: number[] = [];
            const keys = Object.keys(response.cost_models[cm]).sort();
            for (const key of keys) {
              costModel.push(response.cost_models[cm][key]!);
            }
            costModels.set(fromBlockfrostLanguageVersion(cm), costModel);
          }
          return {
            coinsPerUtxoByte: response.coins_per_utxo_size,
            maxTxSize: response.max_tx_size,
            minFeeCoefficient: response.min_fee_a,
            minFeeConstant: response.min_fee_b,
            maxBlockBodySize: response.max_block_size,
            maxBlockHeaderSize: response.max_block_header_size,
            stakeKeyDeposit: response.key_deposit,
            poolDeposit: response.pool_deposit,
            poolRetirementEpochBound: response.e_max,
            desiredNumberOfPools: response.n_opt,
            poolInfluence: response.a0,
            monetaryExpansion: response.rho,
            treasuryExpansion: response.tau,
            minPoolCost: response.min_pool_cost,
            protocolVersion: {
              major: response.protocol_major_ver,
              minor: response.protocol_minor_ver,
            },
            maxValueSize: response.max_val_size,
            collateralPercentage: response.collateral_percent / 100,
            maxCollateralInputs: response.max_collateral_inputs,
            costModels: costModels,
            prices: {
              memory: parseFloat(response.price_mem) / 10000,
              steps: parseFloat(response.price_step) / 10000,
            },
            maxExecutionUnitsPerTransaction: {
              memory: response.max_tx_ex_mem,
              steps: response.max_tx_ex_steps,
            },
            maxExecutionUnitsPerBlock: {
              memory: response.max_block_ex_mem,
              steps: response.max_block_ex_steps,
            },
          };
        }
        throw new Error("getParameters: Could not parse response json");
      });
  }

  /**
   * This method fetches the UTxOs under a given address.
   * It constructs the query URL, sends a GET request with the appropriate headers, and processes the response.
   * The response is parsed into a TransactionUnspentOutput[] type, which is then returned.
   * If the response is not in the expected format, an error is thrown.
   * @returns A Promise that resolves to TransactionUnspentOutput[].
   */
  async getUnspentOutputs(
    address: Address | Credential,
  ): Promise<TransactionUnspentOutput[]> {
    // 100 per page is max allowed by Blockfrost
    const maxPageCount = 100;
    let page = 1;

    const bech32 =
      address instanceof Address
        ? address.toBech32()
        : new Address({
            type: AddressType.EnterpriseKey,
            paymentPart: address.toCore(),
          }).toBech32();

    const buildTxUnspentOutput = buildTransactionUnspentOutput(
      Address.fromBech32(bech32),
    );

    const results: Set<TransactionUnspentOutput> = new Set();

    for (;;) {
      const json = await fetch(
        `${this.url}/addresses/${bech32}/utxos?count=${maxPageCount}&page=${page}`,
        {
          headers: this.headers(),
        },
      ).then((resp) => resp.json());

      if (json) {
        const response = json as BlockfrostResponse<BlockfrostUTxO[]>;
        if ("message" in response) {
          throw new Error(
            `getUnspentOutputs: Blockfrost threw "${response.message}"`,
          );
        }

        for (const blockfrostUTxO of response) {
          results.add(buildTxUnspentOutput(blockfrostUTxO));
        }

        if (response.length < maxPageCount) {
          break;
        } else {
          page = page + 1;
        }
      } else {
        throw new Error("getUnspentOutputs: Could not parse response json");
      }
    }

    return Array.from(results);
  }

  /**
   * This method fetches the UTxOs under a given address that hold
   * a particular asset.
   * @param address Address or Payment Credential.
   * @param unit The AssetId
   * @returns A Promise that resolves to TransactionUnspentOutput[].
   */
  async getUnspentOutputsWithAsset(
    address: Address | Credential,
    unit: AssetIdType,
  ): Promise<TransactionUnspentOutput[]> {
    // 100 per page is max allowed by Blockfrost
    const maxPageCount = 100;
    let page = 1;

    const bech32 =
      address instanceof Address
        ? address.toBech32()
        : new Address({
            type: AddressType.EnterpriseKey,
            paymentPart: address.toCore(),
          }).toBech32();

    const buildTxUnspentOutput = buildTransactionUnspentOutput(
      Address.fromBech32(bech32),
    );

    const asset = AssetId.getPolicyId(unit) + AssetId.getAssetName(unit);

    const results: Set<TransactionUnspentOutput> = new Set();

    for (;;) {
      const json = await fetch(
        `${this.url}/addresses/${bech32}/utxos/${asset}?count=${maxPageCount}&page=${page}`,
        {
          headers: this.headers(),
        },
      ).then((resp) => resp.json());

      if (json) {
        const response = json as BlockfrostResponse<BlockfrostUTxO[]>;
        if ("message" in response) {
          throw new Error(
            `getUnspentOutputsWithAsset: Blockfrost threw "${response.message}"`,
          );
        }

        for (const blockfrostUTxO of response) {
          results.add(buildTxUnspentOutput(blockfrostUTxO));
        }

        if (response.length < maxPageCount) {
          break;
        } else {
          page = page + 1;
        }
      } else {
        throw new Error(
          "getUnspentOutputsWithAssetx: Could not parse response json",
        );
      }
    }

    return Array.from(results);
  }

  /**
   * This method fetches the UTxO that holds a particular NFT.
   * @param unit The AssetId for the NFT
   * @returns A Promise that resolves to TransactionUnspentOutput.
   */
  async getUnspentOutputByNFT(
    unit: AssetId,
  ): Promise<TransactionUnspentOutput> {
    const asset = AssetId.getPolicyId(unit) + AssetId.getAssetName(unit);
    // Fetch addresses holding the asset. Since it's an NFT, a single
    // address is expected to be returned
    const json = await fetch(`${this.url}/assets/${asset}/addresses`, {
      headers: this.headers(),
    }).then((resp) => resp.json());
    if (!json) {
      throw new Error("getUnspentOutputByNFT: Could not parse response json");
    }

    const response = json as BlockfrostResponse<BlockfrostAssetAddress[]>;
    if ("message" in response) {
      throw new Error(
        `getUnspentOutputByNFT: Blockfrost threw "${response.message}"`,
      );
    }
    // Ensures a single asset address is returned
    if (response.length !== 1) {
      throw new Error(
        "getUnspentOutputByNFT: Asset must be held by only one address. Multiple found.",
      );
    }

    const utxo = response[0] as BlockfrostAssetAddress;
    const address = Address.fromBech32(utxo.address);
    // A second call to Blockfrost is needed in order to fetch utxo information
    const utxos = await this.getUnspentOutputsWithAsset(address, unit);
    // Ensures a single UTxO holds the asset
    if (utxos.length !== 1) {
      throw new Error(
        "getUnspentOutputByNFT: Asset must be present in only one UTxO. Multiple found.",
      );
    }

    return utxos[0]!;
  }

  /**
   * This methods resolves transaction outputs from a list of transaction
   * inputs given as argument.
   * @param txIns A list of TransactionInput
   * @returns A Promise that resolves to TransactionUnspentOutput[].
   */
  async resolveUnspentOutputs(
    txIns: TransactionInput[],
  ): Promise<TransactionUnspentOutput[]> {
    const results: Set<TransactionUnspentOutput> = new Set();

    for (const txIn of txIns) {
      const json = await fetch(
        `${this.url}/txs/${txIn.transactionId()}/utxos`,
        {
          headers: this.headers(),
        },
      ).then((resp) => resp.json());

      if (!json) {
        throw new Error("resolveUnspentOutputs: Could not parse response json");
      }

      const response = json as BlockfrostResponse<{
        outputs: BlockfrostUTxO[];
      }>;

      if ("message" in response) {
        throw new Error(
          `resolveUnspentOutputs: Blockfrost threw "${response.message}"`,
        );
      }

      const txIndex = BigInt(txIn.index());

      for (const blockfrostUTxO of response.outputs) {
        if (BigInt(blockfrostUTxO.output_index) !== txIndex) {
          // Ignore outputs whose index don't match
          // the index we are looking for
          continue;
        }

        blockfrostUTxO.tx_hash = txIn.transactionId();

        const buildTxUnspentOutput = buildTransactionUnspentOutput(
          Address.fromBech32(blockfrostUTxO.address),
        );

        results.add(buildTxUnspentOutput(blockfrostUTxO));
      }
    }

    return Array.from(results);
  }

  resolveDatum(_datumHash: DatumHash): Promise<PlutusData> {
    throw new Error("unimplemented");
  }

  async awaitTransactionConfirmation(
    _txId: TransactionId,
    _timeout?: number,
  ): Promise<boolean> {
    throw new Error("unimplemented");
  }

  async postTransactionToChain(_tx: Transaction): Promise<TransactionId> {
    throw new Error("unimplemented");
  }

  async evaluateTransaction(_tx: Transaction): Promise<Redeemers> {
    throw new Error("unimplemented");
  }
}

// Partially applies address in order to avoid sending it
// as argument repeatedly when building TransactionUnspentOutput
function buildTransactionUnspentOutput(
  address: Address,
): (blockfrostUTxO: BlockfrostUTxO) => TransactionUnspentOutput {
  return (blockfrostUTxO) => {
    const txIn = new TransactionInput(
      TransactionId(blockfrostUTxO.tx_hash),
      BigInt(blockfrostUTxO.output_index),
    );
    // No tx output CBOR available from Blockfrost,
    // so TransactionOutput must be manually constructed.
    const tokenMap: TokenMap = new Map<AssetId, bigint>();
    let lovelace = 0n;
    for (const { unit, quantity } of blockfrostUTxO.amount) {
      if (unit === "lovelace") {
        lovelace = quantity;
      } else {
        tokenMap.set(unit as AssetId, quantity);
      }
    }
    const txOut = new TransactionOutput(address, new Value(lovelace, tokenMap));

    return new TransactionUnspentOutput(txIn, txOut);
  };
}

type BlockfrostLanguageVersions = "PlutusV1" | "PlutusV2" | "PlutusV3";
export const fromBlockfrostLanguageVersion = (
  x: BlockfrostLanguageVersions,
): PlutusLanguageVersion => {
  if (x == "PlutusV1") {
    return PlutusLanguageVersion.V1;
  } else if (x == "PlutusV2") {
    return PlutusLanguageVersion.V2;
  } else if (x == "PlutusV3") {
    return PlutusLanguageVersion.V3;
  }
  throw new Error("fromBlockfrostLanguageVersion: Unreachable!");
};

export interface BlockfrostProtocolParametersResponse {
  epoch: number;
  min_fee_a: number;
  min_fee_b: number;
  max_block_size: number;
  max_tx_size: number;
  max_block_header_size: number;
  key_deposit: number;
  pool_deposit: number;
  e_max: number;
  n_opt: number;
  a0: string;
  rho: string;
  tau: string;
  decentralisation_param: number;
  extra_entropy: null;
  protocol_major_ver: number;
  protocol_minor_ver: number;
  min_utxo: string;
  min_pool_cost: number;
  nonce: string;
  cost_models: Record<BlockfrostLanguageVersions, { [key: string]: number }>;
  price_mem: string;
  price_step: string;
  max_tx_ex_mem: number;
  max_tx_ex_steps: number;
  max_block_ex_mem: number;
  max_block_ex_steps: number;
  max_val_size: number;
  collateral_percent: number;
  max_collateral_inputs: number;
  coins_per_utxo_size: number;
}

type BlockfrostResponse<SomeResponse> = SomeResponse | { message: string };

interface BlockfrostUTxO {
  address: string;
  tx_hash: string;
  output_index: number;
  amount: {
    unit: string;
    quantity: bigint;
  }[];
  block: string;
  data_hash?: string;
  inline_datum?: string;
  reference_script_hash?: string;
}

interface BlockfrostAssetAddress {
  address: string;
  quantity: string;
}
