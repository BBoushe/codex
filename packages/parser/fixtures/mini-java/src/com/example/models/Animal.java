package com.example.models;

import com.example.util.Formatter;

/**
 * Base class for all animals in the system.
 */
public abstract class Animal {
    private String name;
    private int age;

    public Animal(String name, int age) {
        this.name = name;
        this.age = age;
    }

    public String getName() {
        return name;
    }

    public int getAge() {
        return age;
    }

    public String getDisplayName() {
        return Formatter.capitalize(name);
    }

    public abstract String speak();
}
