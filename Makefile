.PHONY: build frontend install test run clean

BUILD_TIME := $(shell date '+%Y-%m-%d %H:%M')
NPM := npm

build: frontend
	go build -ldflags "-X 'main.buildTime=$(BUILD_TIME)'" -o rackops .

install:
	cd web && $(NPM) ci --include=dev --no-audit --no-fund

frontend:
	@cd web && if [ ! -d node_modules ]; then $(NPM) ci --include=dev --no-audit --no-fund; fi && $(NPM) run build

test:
	go test ./...

run: build
	./rackops

clean:
	rm -rf web/dist rackops
