#!/bin/sh
# Build Can's desktop engine from main.swift. Needs the Xcode Command
# Line Tools (swiftc). Produces ./Can next to this script — the product
# name, so everything the system shows (permissions, errors) says Can.
set -e
cd "$(dirname "$0")"
swiftc -O -o Can main.swift
echo "built: $(pwd)/Can"
