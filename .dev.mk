#!/usr/bin/make -f

SRCFILES=$(shell find src/*/ -name '*.ts')
DSTFILES=$(subst .ts,.js,$(subst src/,dist/,$(SRCFILES)))
PLUGINFILES=$(shell find dist/plugins -name '*.js' -a ! -name 'auth*')
ALLPLUGINS=$(subst dist/plugins/,--plugin core/,$(subst .js,,$(PLUGINFILES)))

all: $(DSTFILES)

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

start: $(DSTFILES)
	node bin/index.mjs $(ALLPLUGINS)

test: $(DSTFILES)
	npm run test

.PHONY: builddev,builddocker,test