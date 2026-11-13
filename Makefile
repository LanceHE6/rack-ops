.PHONY: build frontend test run clean

BUILD_TIME := $(shell date '+%Y-%m-%d %H:%M')

build: frontend
	go build -ldflags "-X 'main.buildTime=$(BUILD_TIME)'" -o rackops .

frontend:
	cd web && npm run build

test:
	go test ./...

run: build
	./rackops

clean:
	rm -rf web/dist rackops
