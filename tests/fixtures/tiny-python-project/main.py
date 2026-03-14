"""Entry point for the tiny calculator application."""
from calculator import Calculator


def main():
    calc = Calculator()
    print(f"2 + 3 = {calc.add(2, 3)}")
    print(f"10 - 4 = {calc.subtract(10, 4)}")


if __name__ == "__main__":
    main()
