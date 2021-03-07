import { request, gql } from 'graphql-request'
import { Worker } from 'worker_threads'
import { Logger } from '../utils/logger'
import * as path from 'path'
import { Mutex } from 'async-mutex'
import { HistoryModel } from '../models/history.model'
import { append, getPairWeekData } from '../controllers/history.controller'
import { HistorySchemaDefine } from '../models/history.schema'

const DEFI_NAME = "UniswapV2"
const UNISWAP_ENDPOINT = "https://api.thegraph.com/subgraphs/name/uniswap/uniswap-v2"
const ETH_ENDPOINT = "https://api.thegraph.com/subgraphs/name/blocklytics/ethereum-blocks"

interface IAllPairs {
  pairs: { id: string }[],
}

interface IEthBlockInfo {
  blocks: {
    number: string,
  }[]
}

interface IPairInfo {
  pair: {
    reserveUSD: string,
    token0: ITokenInfo,
    token1: ITokenInfo,
    volumeUSD: string
  }
}

interface ITokenInfo {
  symbol: string
}

export class UniswapSyncher {
  private static _self: UniswapSyncher
  private _mutex = new Mutex()
  private _logger = Logger.instance.logger

  get mutex() {
    return this._mutex
  }

  static get instance() {
    if (!this._self) {
      this._self = new UniswapSyncher()
    }
    return this._self
  }

  static schedule() {
    if (!this._self) {
      this._self = new UniswapSyncher()
    }

    // test
    new Worker(path.join(__dirname, 'worker.js'), { execArgv: [] })
  }

  static async process() {
    if (!this._self) {
      this._self = new UniswapSyncher()
    }

    const release = await this._self._mutex.acquire()
    try {
      await this._self.processInternal()
    } finally {
      release()
    }
  }

  private constructor() {
    
  }

  private async processInternal() {
    const time = new Date().getTime();
    const currentTime = Math.floor(time / 1000);
    const oneDayAgoTime = currentTime - 24 * 60 * 60;

    let ethBlockInfo: IEthBlockInfo
    try {
      ethBlockInfo = await this.getEthTransactionInfo(oneDayAgoTime)
    } catch (err) {
      this._logger?.error("Faild get eth blog info. err = " + err)
      return
    }

    let pairs: IAllPairs
    try {
      pairs = await this.getTopLiquidPairs()
    } catch (err) {
      this._logger?.error("Faild get pairs info. err = " + err)
      return
    }

    pairs.pairs.map(async (value: { id: string }) => {
      let pairData: IPairInfo[]
      try {
        pairData = await Promise.all([
          this.getPairData(value.id, ethBlockInfo.blocks[0].number),
          this.getPairData(value.id)
        ])
      } catch (err) {
        this._logger?.error("Faild get pair. err = " + err)
        return
      }

      if (pairData.length < 2) {
        this._logger?.error("Invalid pair length")
        return
      }

      const volumeUSD = parseFloat(pairData[1].pair.volumeUSD)
      if (volumeUSD <= 0) {
        return
      }

      var aprWeak = -1
      try {
        aprWeak = await this.getAprWeek(value.id)
      } catch (err) {

      }

      var appendData = {
        [HistorySchemaDefine.DEFI_NAME]: DEFI_NAME,
        [HistorySchemaDefine.RESERVED_USD]: parseFloat(pairData[1].pair.reserveUSD),
        [HistorySchemaDefine.VOLUME_USD]: volumeUSD,
        [HistorySchemaDefine.PAIR_ID]: value.id,
        [HistorySchemaDefine.PAIR_NAME]: pairData[0].pair.token0.symbol + "-" + pairData[0].pair.token1.symbol,
        [HistorySchemaDefine.APR]: this.getApr(pairData[0], pairData[1]),
        [HistorySchemaDefine.APR_WEEK]: aprWeak
      }

      append(appendData)
    })
  }

  private async getPairData(pair: string, block : string|undefined = undefined): Promise<IPairInfo>{
    const endpoint = "https://api.thegraph.com/subgraphs/name/uniswap/uniswap-v2";

    return new Promise((resolve, reject) => {
      var blockNumber = ""
      if (block) {
        blockNumber = `block: { number: ${block} }`
      }

      const query = gql`
      {
        pair(
          id: "${pair}"
          ${blockNumber}
        ) {
          token0 {
            symbol
          }
          token1 {
            symbol
          }
          reserveUSD
          volumeUSD
        }
      }
    `;

      request(endpoint, query)
        .then((data) => {
          const json = JSON.parse(JSON.stringify(data));
          resolve(json);
        })
        .catch((error) => {
          reject(error);
        });
    });
  }

  private async getTopLiquidPairs(): Promise<IAllPairs> {
    return new Promise((resolve, reject) => {
      const query = gql`
      {
        pairs(
          first: 110
          orderBy: reserveUSD
          orderDirection: desc
        ) {
          id
        }
      }
    `;

      request(UNISWAP_ENDPOINT, query)
        .then((data) => {
          const json = JSON.parse(JSON.stringify(data));
          resolve(json);
        })
        .catch((error) => {
          reject(error);
        });
    })
  }


  private async getEthTransactionInfo(time: number): Promise<IEthBlockInfo> {
    return new Promise((resolve, reject) => {
      const query = gql`
      {
        blocks(first: 1, orderBy: timestamp, orderDirection: asc, where: {timestamp_gt: "${time}"}) {
            number
        }
      }
    `
      request(ETH_ENDPOINT, query).then((data) => {
        const json = JSON.parse(JSON.stringify(data))
        this._logger?.debug(JSON.stringify(data));
        resolve(json);
      }).catch((error) => {
        reject(error);
      })
    });
  }

  private getApr(previous: IPairInfo, current: IPairInfo): number {
    const baseVolume = parseFloat(previous.pair.volumeUSD);
    const currentVolume = parseFloat(current.pair.volumeUSD);

    const volume = currentVolume - baseVolume;

    const reservedUSD = parseFloat(current.pair.reserveUSD);
    return this.getAnnualInterest(reservedUSD, volume)
  }

  private getAnnualInterest(liquidity: number, volume: number) {
    const ratio = volume / liquidity
    const day = ratio * 0.003;
    const month = ((1 + day) ** 30 - 1) * 100;
    const year = ((1 + day) ** 365 - 1) * 100

    return year
  }

  private async getAprWeek(pairId: string): Promise<number> {
    return new Promise(async (resolve, reject) => {
      try {
        const weekData = await getPairWeekData(DEFI_NAME, pairId)

        if (weekData.length < 2) {
          this._logger?.debug("historical pair data size = " + weekData.length)
          reject(-1)
          return
        }

        const totalVolume = weekData.reduce((acc, val): number => {
          return acc + val.volumeUSD
        }, 0)

        const volumeAverage = totalVolume / weekData.length

        resolve(this.getAnnualInterest(weekData[0].reserveUSD, volumeAverage))
      } catch (err) {
        reject(-1)
      }
    })
  }
}