#!/usr/bin/env python3
# LinCut: разделение звука на голос и фон (audio-separator, модель BS-Roformer).
# Прогресс печатает tqdm в stderr («  37%|…»), результат — строкой «RESULT {json}» в stdout.
import argparse, json, logging, os, sys

p = argparse.ArgumentParser()
p.add_argument('input')
p.add_argument('outdir')
p.add_argument('--models', required=True)
p.add_argument('--model', default='model_bs_roformer_ep_317_sdr_12.9755.ckpt')
p.add_argument('--name', default='stem')
p.add_argument('--download-only', action='store_true')
a = p.parse_args()

from audio_separator.separator import Separator

os.makedirs(a.models, exist_ok=True)
sep = Separator(output_dir=a.outdir, model_file_dir=a.models, output_format='FLAC', log_level=logging.WARNING)
sep.load_model(model_filename=a.model)
if a.download_only:
    print('READY', flush=True)
    sys.exit(0)
os.makedirs(a.outdir, exist_ok=True)
files = sep.separate(a.input, custom_output_names={'Vocals': a.name + '_voice', 'Instrumental': a.name + '_bg'})
print('RESULT ' + json.dumps([os.path.join(a.outdir, os.path.basename(f)) for f in files]), flush=True)
