package com.example.models;

/**
 * Simple enum for testing enum extraction.
 */
public enum Color {
    RED,
    GREEN,
    BLUE;

    public String lower() {
        return name().toLowerCase();
    }
}
