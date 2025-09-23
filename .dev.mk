#!/usr/bin/make -f

SRCFILES=$(shell find src/*/ -name '*.ts')
DSTFILES=$(subst .ts,.js,$(subst src/,dist/,$(SRCFILES)))

dist/%.js: src/%.ts
	$(MAKE) -f .dev.mk builddev

build:
	npm run build:prod

builddev:
	npm run build:dev

builddocker: Dockerfile
	docker build -t mini-dm .

Dockerfile: scripts/buildDockerfile.ts $(SRCFILES) bin rollup.config.mjs tsconfig.json static
	npx tsx scripts/buildDockerfile.ts

test: $(DSTFILES)
	npm run test

.PHONY: builddev,builddocker,test