.PHONY: install build test package clean

install:
	npm install

build:
	npm run compile

test:
	npm test

package: build
	npx @vscode/vsce package

clean:
	rm -rf out node_modules *.vsix
