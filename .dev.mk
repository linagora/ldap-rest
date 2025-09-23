#!/usr/bin/make -f

SRCFILES=$(shell find src/*/ -name '*.ts')
DSTFILES=$(subst .ts,.js,$(subst src/,dist/,$(SRCFILES)))

dist/%.js: src/%.ts
	$(MAKE) -f .dev.mk builddev

builddev:
	npm run build:dev

test: $(DSTFILES)
	npm run test

.PHONY: builddev,test