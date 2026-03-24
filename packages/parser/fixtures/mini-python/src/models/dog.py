from typing import List, Optional
from .animal import Animal
from ..util.formatter import format_template


class Dog(Animal):
    """Dog extends Animal with breed and tricks."""

    def __init__(self, name: str, age: int, breed: str = "Unknown"):
        super().__init__(name, age)
        self.breed = breed
        self._tricks: List[str] = []

    def speak(self) -> str:
        return "Woof!"

    def add_trick(self, trick: str) -> None:
        self._tricks.append(trick)

    def get_tricks(self) -> List[str]:
        return list(self._tricks)

    @staticmethod
    def create(name: str) -> 'Dog':
        return Dog(name, 0)

    @classmethod
    def from_dict(cls, data: dict) -> 'Dog':
        return cls(data['name'], data['age'], data.get('breed', 'Unknown'))

    def to_json(self) -> str:
        return format_template(
            '{"name": "%s", "age": %d, "breed": "%s"}',
            self.name, self.age, self.breed
        )
