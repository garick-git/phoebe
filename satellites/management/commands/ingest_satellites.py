import json
import time

from django.core.management.base import BaseCommand

from satellites.ingest import fetch_omm, ingest_records


class Command(BaseCommand):
    help = "Load active satellites from CelesTrak (or a saved JSON file) into the database."

    def add_arguments(self, parser):
        parser.add_argument(
            "--file",
            help="Load from a saved CelesTrak JSON file instead of downloading.",
        )

    def handle(self, *args, **options):
        start = time.perf_counter()

        if options["file"]:
            with open(options["file"]) as f:
                records = json.load(f)
        else:
            records = fetch_omm()

        result = ingest_records(records)
        elapsed = time.perf_counter() - start

        self.stdout.write(
            self.style.SUCCESS(
                f"{result['satellites']:,} satellites upserted, "
                f"{result['element_sets_added']:,} new element sets added "
                f"in {elapsed:.1f}s"
            )
        )
