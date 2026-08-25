#!/bin/bash
cd "$(dirname "$0")"
export PATH="/Users/rtreese/.nvm/versions/node/v20.20.1/bin:$PATH"
./node_modules/.bin/electron .
