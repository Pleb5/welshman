#!/bin/bash

for package in $(./get_packages.py); do
  source build_and_link.sh $package
done
