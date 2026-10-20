def test_ci_blocks_failing_merges():
    """Deliberately failing: proves the ruleset blocks a red PR. Never merge."""
    assert 1 + 1 == 3
