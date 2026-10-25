# OpenRoute do-file example (same vocabulary as an Allegro-generated <name>_route.do)
#   npm run route -- examples/demo.dsn -do examples/route.do
unit mm
rule pcb (width 0.25) (clearance 0.2 (type wire_wire))
status_file $/route.sts
fanout
route 25
clean 2
route 50 16
clean 4
write session $/demo.ses
report status $/demo.sts
report conflicts $/demo_drc.txt
quit
