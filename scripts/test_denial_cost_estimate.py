import importlib.util
from pathlib import Path
import unittest
from decimal import Decimal

spec = importlib.util.spec_from_file_location('cost', Path(__file__).with_name('denial-cost-estimate.py'))
cost = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cost)


class CostTests(unittest.TestCase):
    def test_shared_allowance_boundary_and_rounding(self):
        self.assertEqual(cost.charge(1000000, 1000000, '4.50', True), 0)
        self.assertEqual(cost.charge(1000001, 1000000, '4.50', True), Decimal('4.50'))
        self.assertEqual(cost.charge(2000001, 1000000, '4.50', True), Decimal('9.00'))

    def test_queue_proration_and_zero_floor(self):
        self.assertEqual(cost.charge(1500000, 1000000, '.40', False), Decimal('.20'))
        self.assertEqual(cost.charge(1, 1000000, '.40', False), 0)

    def test_reject_unknown_or_invalid_usage(self):
        for value in [-1, 'NaN', 'Infinity', '-Infinity']:
            with self.assertRaises(ValueError):
                cost.number(value)

    def test_observation_scaling(self):
        prices = {k: {'perMillionUSD': 1, 'monthlyAllowance': 0, 'roundMillionUnits': False}
                  for k in ['r2ClassA', 'r2ClassB', 'queueOperations']}
        window = {'name': 'fixture', 'durationSeconds': 180,
                  'r2ClassA': 18, 'r2ClassB': 45, 'queueOperations': 36}
        result = cost.estimate(window, prices)
        self.assertEqual(Decimal(result['components']['r2ClassA']['projected30DayOperations']), 259200)
        self.assertEqual(Decimal(result['unroundedGrossSubtotalUSD']), Decimal('1.4256'))
        for bad in [{**window, 'durationSeconds': 0}, {**window, 'r2ClassA': '1.5'}]:
            with self.assertRaises(ValueError):
                cost.estimate(bad, prices)


if __name__ == '__main__':
    unittest.main()
