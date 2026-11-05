#!/bin/sh
# Build can-helper from main.swift. Needs the Xcode Command Line Tools
# (swiftc). Produces ./can-helper next to this script.
set -e
cd "$(dirname "$0")"
swiftc -O -o can-helper main.swift
echo "built: $(pwd)/can-helper"
