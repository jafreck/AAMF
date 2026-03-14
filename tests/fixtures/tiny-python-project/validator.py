"""Input validation helpers."""


def is_number(value: str) -> bool:
    try:
        float(value)
        return True
    except ValueError:
        return False
