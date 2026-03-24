from typing import List, Optional
from ..models.animal import Animal
from ..models.dog import Dog
from ..util.validator import validate_age


class AnimalService:
    """Service layer for managing animals."""

    def __init__(self) -> None:
        self._animals: List[Animal] = []

    def add_animal(self, animal: Animal) -> None:
        if validate_age(animal.age):
            self._animals.append(animal)

    def create_dog(self, name: str, age: int, breed: str = "Unknown") -> Dog:
        dog = Dog(name, age, breed)
        self.add_animal(dog)
        return dog

    def get_all_sounds(self) -> List[str]:
        return [animal.speak() for animal in self._animals]

    def find_by_name(self, name: str) -> Optional[Animal]:
        for animal in self._animals:
            if animal.name == name:
                return animal
        return None

    @property
    def count(self) -> int:
        return len(self._animals)

    def print_all(self) -> None:
        for animal in self._animals:
            print(animal.describe())
