.PHONY: install run test demo openapi reset clean

install:
	python -m pip install -e '.[dev]'

run:
	python -m uvicorn relaymock.main:app --reload --host 127.0.0.1 --port 8000

test:
	python -m pytest

demo:
	RELAYMOCK_BASE_URL=http://127.0.0.1:8000 python scripts/demo_client.py

openapi:
	RELAYMOCK_ENABLE_MOCK_ADMIN=true python -c 'import json; from relaymock.main import app; print(json.dumps(app.openapi(), ensure_ascii=False, indent=2))' > openapi.json

reset:
	curl -fsS -X POST http://127.0.0.1:8000/v1/mock/reset -H 'X-Mock-Admin: local-admin'

clean:
	rm -rf data .pytest_cache *.egg-info
	find . -type d -name __pycache__ -prune -exec rm -rf {} +
