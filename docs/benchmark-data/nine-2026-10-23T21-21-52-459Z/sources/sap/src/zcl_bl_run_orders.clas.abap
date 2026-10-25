CLASS zcl_bl_run_orders DEFINITION PUBLIC FINAL CREATE PUBLIC.
 PUBLIC SECTION.
  INTERFACES if_oo_adt_classrun.
ENDCLASS.
CLASS zcl_bl_run_orders IMPLEMENTATION.
 METHOD if_oo_adt_classrun~main.
  DATA(config) = zcl_bl_poll_orders=>defaults( ).
  config-service_root = 'http://localhost:50000/sap/opu/odata4/sap/zui_bl_orders_o4/srvd_a2x/sap/zui_bl_orders/0001/'.
  config-expected_rows = 5000.
  config-expected_digest = 'df57de597e919adb10ae5365201b999788e86b39219ad040ffbc305539180bc7'.
  DATA(poller) = NEW zcl_bl_poll_orders( ).
  DATA(results) = poller->run( config = config internal = abap_true ).
  LOOP AT results INTO DATA(result).
    out->write( zcl_bl_poll_orders=>to_json( result ) ).
  ENDLOOP.
 ENDMETHOD.
ENDCLASS.
