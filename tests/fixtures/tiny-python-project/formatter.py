"""Formats calculation results for display."""


def format_result(operation: str, a: float, b: float, result: float) -> str:
    return f"{a} {operation} {b} = {result}"
