import { NetworkId } from '@synthetixio/contracts-interface';
import Wei from '@synthetixio/wei';
import request, { gql } from 'graphql-request';
import { useTranslation } from 'react-i18next';
import { useQuery, UseQueryOptions } from 'react-query';
import { useRecoilValue, useSetRecoilState } from 'recoil';

import { Period, PERIOD_IN_SECONDS } from 'constants/period';
import QUERY_KEYS from 'constants/queryKeys';
import Connector from 'containers/Connector';
import { fundingRatesState, futuresMarketsState, marketAssetsState } from 'store/futures';
import { FuturesMarketKey, MarketKeyByAsset } from 'utils/futures';
import logError from 'utils/logError';

import { FundingRateUpdate } from './types';
import { getFuturesEndpoint, calculateFundingRate } from './utils';

type FundingRateInput = {
	marketAddress: string | undefined;
	marketKey: FuturesMarketKey;
	price: Wei | undefined;
	currentFundingRate: Wei | undefined;
};

export type FundingRateResponse = {
	asset: FuturesMarketKey;
	fundingTitle: string;
	fundingRate: Wei | null;
};

const useGetAverageFundingRateForMarkets = (
	period: Period,
	options?: UseQueryOptions<any | null>
) => {
	const { t } = useTranslation();
	const { network } = Connector.useContainer();

	const futuresMarkets = useRecoilValue(futuresMarketsState);
	const marketAssets = useRecoilValue(marketAssetsState);
	const futuresEndpoint = getFuturesEndpoint(network?.id as NetworkId);
	const setFundingRates = useSetRecoilState(fundingRatesState);

	const fundingRateInputs: FundingRateInput[] = futuresMarkets.map(
		({ asset, market, price, currentFundingRate }) => {
			return {
				marketAddress: market,
				marketKey: MarketKeyByAsset[asset],
				price: price,
				currentFundingRate: currentFundingRate,
			};
		}
	);

	const periodLength = PERIOD_IN_SECONDS[period];

	const periodTitle =
		period === Period.ONE_HOUR
			? t('futures.market.info.hourly-funding')
			: t('futures.market.info.fallback-funding');

	return useQuery<any>(
		QUERY_KEYS.Futures.FundingRates(network?.id as NetworkId, periodLength, marketAssets),
		async () => {
			const minTimestamp = Math.floor(Date.now() / 1000) - periodLength;

			const fundingRatePromises = fundingRateInputs.map(
				({ marketAddress, marketKey, price, currentFundingRate }) => {
					try {
						const response = request(
							futuresEndpoint,
							gql`
								query fundingRateUpdates($market: String!, $minTimestamp: BigInt!) {
									# last before timestamp
									first: fundingRateUpdates(
										first: 1
										where: { market: $market, timestamp_lt: $minTimestamp }
										orderBy: sequenceLength
										orderDirection: desc
									) {
										timestamp
										funding
									}

									# first after timestamp
									next: fundingRateUpdates(
										first: 1
										where: { market: $market, timestamp_gt: $minTimestamp }
										orderBy: sequenceLength
										orderDirection: asc
									) {
										timestamp
										funding
									}

									# latest update
									latest: fundingRateUpdates(
										first: 1
										where: { market: $market }
										orderBy: sequenceLength
										orderDirection: desc
									) {
										timestamp
										funding
									}
								}
							`,
							{ market: marketAddress, minTimestamp: minTimestamp }
						).then((response: { string: FundingRateUpdate[] }): FundingRateResponse | null => {
							if (!price) return null;
							const responseFilt = Object.values(response)
								.filter((value: FundingRateUpdate[]) => value.length > 0)
								.map((entry: FundingRateUpdate[]): FundingRateUpdate => entry[0])
								.sort((a: FundingRateUpdate, b: FundingRateUpdate) => a.timestamp - b.timestamp);

							const fundingRate =
								responseFilt && !!currentFundingRate
									? calculateFundingRate(
											minTimestamp,
											periodLength,
											responseFilt,
											price,
											currentFundingRate
									  )
									: currentFundingRate ?? null;

							const fundingPeriod =
								responseFilt && !!currentFundingRate
									? periodTitle
									: t('futures.markets.info.instant-funding');

							const fundingRateResponse: FundingRateResponse = {
								asset: marketKey,
								fundingTitle: fundingPeriod,
								fundingRate: fundingRate,
							};
							return fundingRateResponse;
						});
						return response;
					} catch (e) {
						logError(e);
						return null;
					}
				}
			);

			const fundingRateResponses = await Promise.all(fundingRatePromises);
			const fundingRates: FundingRateResponse[] = fundingRateResponses.filter(
				(funding): funding is FundingRateResponse => !!funding
			);

			setFundingRates(fundingRates);
		},
		{
			enabled: futuresMarkets.length > 0 && futuresMarkets.length === marketAssets.length,
			...options,
		}
	);
};

export default useGetAverageFundingRateForMarkets;
