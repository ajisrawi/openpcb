"""Import an OpenRoute session (.ses) into a KiCad board, like Allegro's File - Import - Router.

usage (KiCad's bundled python):
  "C:/Program Files/KiCad/10.0/bin/python.exe" examples/kicad_import_ses.py <board.kicad_pcb> <session.ses> <out.kicad_pcb>
"""
import sys
import pcbnew

board_path, ses_path, out_path = sys.argv[1], sys.argv[2], sys.argv[3]
board = pcbnew.LoadBoard(board_path)
ok = pcbnew.ImportSpecctraSES(board, ses_path)
if not ok:
    print("ImportSpecctraSES returned False")
    sys.exit(1)
# re-fill zones so pours yield to the imported traces
try:
    filler = pcbnew.ZONE_FILLER(board)
    filler.Fill(board.Zones())
except Exception as e:  # pragma: no cover
    print("zone fill skipped:", e)
pcbnew.SaveBoard(out_path, board)
tracks = sum(1 for t in board.GetTracks() if t.GetClass() == "PCB_TRACK")
vias = sum(1 for t in board.GetTracks() if t.GetClass() == "PCB_VIA")
print(f"imported: {tracks} track segments, {vias} vias -> {out_path}")
