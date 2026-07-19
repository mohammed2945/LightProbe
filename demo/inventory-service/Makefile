SHELL := /bin/sh

MVN ?= mvn
JAVA ?= java
JAVAC ?= javac
NODE ?= node

.PHONY: validate check-jdk test package run traffic smoke e2e clean

validate:
	$(NODE) scripts/validate.mjs
	$(NODE) --check scripts/validate.mjs
	sh -n scripts/smoke.sh
	sh -n scripts/e2e.sh
	sh -n docker-entrypoint.sh

check-jdk:
	@command -v "$(JAVAC)" >/dev/null 2>&1 || { echo "javac is required"; exit 1; }
	@major=$$("$(JAVAC)" -version 2>&1 | awk '{ split($$2, v, "."); if (v[1] == "1") print v[2]; else print v[1] }'); \
		[ "$$major" -ge 17 ] || { echo "JDK 17+ is required (found javac $$major)"; exit 1; }
	@command -v "$(MVN)" >/dev/null 2>&1 || { echo "Maven 3.9+ is required"; exit 1; }

test: validate check-jdk
	$(MVN) --batch-mode --no-transfer-progress test

package: validate check-jdk
	$(MVN) --batch-mode --no-transfer-progress clean package

run: package
	BUG=on PORT=8080 "$(JAVA)" -jar target/inventory-service.jar

traffic: package
	TARGET_URL=http://127.0.0.1:8080 "$(JAVA)" \
		-cp target/inventory-service.jar \
		io.liveprobe.demo.inventory.TrafficGenerator

smoke: package
	sh scripts/smoke.sh

e2e: smoke

clean:
	rm -rf target
