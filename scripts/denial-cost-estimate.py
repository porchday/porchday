#!/usr/bin/env python3
"""Scenario arithmetic, not an invoice or capacity acceptance. Prices dated in input."""
import json
import sys
from decimal import Decimal, ROUND_CEILING

MILLION = Decimal(1000000)
MONTH_SECONDS = Decimal(30 * 24 * 60 * 60)


def number(value):
    n = Decimal(str(value))
    if not n.is_finite() or n < 0:
        raise ValueError('Expected finite nonnegative usage')
    return n


def charge(operations, allowance, rate, rounded):
    units = max(Decimal(0), number(operations) - number(allowance)) / MILLION
    if rounded:
        units = units.to_integral_value(rounding=ROUND_CEILING)
    return units * number(rate)


def estimate(window, prices):
    seconds = number(window['durationSeconds'])
    if not seconds:
        raise ValueError('Observation duration must be positive')
    result = {'name': window['name'], 'durationSeconds': str(seconds), 'components': {}}
    for component in ['r2ClassA', 'r2ClassB', 'queueOperations']:
        observed = number(window[component])
        if observed != observed.to_integral_value():
            raise ValueError('Observed counts must be integers')
        monthly = observed * MONTH_SECONDS / seconds
        price = prices[component]
        result['components'][component] = {
            'observed': int(observed), 'projected30DayOperations': str(monthly),
            'unroundedGrossUSD': str(charge(monthly, 0, price['perMillionUSD'], False)),
            'isolatedBillWithEntireAllowanceUSD': str(charge(
                monthly, price['monthlyAllowance'], price['perMillionUSD'], price['roundMillionUnits'])),
        }
    result['unroundedGrossSubtotalUSD'] = str(sum(
        Decimal(c['unroundedGrossUSD']) for c in result['components'].values()))
    result['isolatedSubtotalWithEntireAllowanceUSD'] = str(sum(
        Decimal(c['isolatedBillWithEntireAllowanceUSD']) for c in result['components'].values()))
    return result


def main():
    with open(sys.argv[1]) as source:
        data = json.load(source)
    print(json.dumps({
        'pricingChecked': data['pricingChecked'],
        'scope': '30-day constant-rate scenarios for recorded R2 and queue operations only; not a total bill or upper bound',
        'assumptions': data['assumptions'],
        'windows': [estimate(w, data['prices']) for w in data['windows']],
    }, indent=2))


if __name__ == '__main__':
    main()
