CLASS zcl_bl_seed_orders DEFINITION PUBLIC FINAL CREATE PUBLIC.
 PUBLIC SECTION.
  INTERFACES if_oo_adt_classrun.
ENDCLASS.
CLASS zcl_bl_seed_orders IMPLEMENTATION.
 METHOD if_oo_adt_classrun~main.
  DATA headers TYPE STANDARD TABLE OF zbl_ord_hdr WITH EMPTY KEY.
  DATA positions TYPE STANDARD TABLE OF zbl_ord_pos WITH EMPTY KEY.
  DATA tab TYPE string VALUE cl_abap_char_utilities=>horizontal_tab.
  DATA lf TYPE string VALUE cl_abap_char_utilities=>newline.
  DATA hash TYPE string.
  TRY.
   DATA(md) = cl_abap_message_digest=>get_instance( 'SHA-256' ).
   md->update( cl_abap_message_digest=>string_to_xstring( |sap-polling-lab{ tab }1{ lf }| ) ).
   DO 1000 TIMES.
    DATA(order_no) = sy-index.
    DATA(header) = VALUE zbl_ord_hdr(
     client = sy-mandt order_id = |{ order_no WIDTH = 20 ALIGN = RIGHT PAD = '0' }|
     customer_id = |C{ order_no WIDTH = 9 ALIGN = RIGHT PAD = '0' }|
     order_date = '20260101' status = 'N' currency = 'CHF'
     created_at = utclong_current( ) last_changed_at = utclong_current( ) ).
    DO 5 TIMES.
     DATA(item_no) = sy-index.
     DATA(position) = VALUE zbl_ord_pos(
      client = sy-mandt order_id = header-order_id position_number = item_no * 10
      material_id = |M{ item_no WIDTH = 17 ALIGN = RIGHT PAD = '0' }|
      quantity = item_no unit = 'EA' net_amount = order_no + item_no currency = 'CHF'
      last_changed_at = header-last_changed_at ).
     APPEND position TO positions.
     header-net_amount += position-net_amount.
     DATA(amount) = order_no + item_no.
     DATA(row) = |{ header-order_id }{ tab }{ position-position_number }{ tab }{ header-customer_id }{ tab }2026-01-01{ tab }{ position-material_id }{ tab }{ item_no NUMBER = RAW }.000{ tab }EA{ tab }{ amount NUMBER = RAW }.00{ tab }CHF{ lf }|.
     md->update( cl_abap_message_digest=>string_to_xstring( row ) ).
    ENDDO.
    APPEND header TO headers.
   ENDDO.
   IF lines( headers ) <> 1000 OR lines( positions ) <> 5000.
    out->write( '{"outcome":"error","code":"SEED"}' ).
    RETURN.
   ENDIF.
   DELETE FROM zbl_ord_pos.
   DELETE FROM zbl_ord_hdr.
   INSERT zbl_ord_hdr FROM TABLE @headers.
   IF sy-subrc <> 0.
    ROLLBACK WORK.
    out->write( '{"outcome":"error","code":"INSERT_HEADER"}' ).
    RETURN.
   ENDIF.
   INSERT zbl_ord_pos FROM TABLE @positions.
   IF sy-subrc <> 0.
    ROLLBACK WORK.
    out->write( '{"outcome":"error","code":"INSERT_POSITION"}' ).
    RETURN.
   ENDIF.
   COMMIT WORK AND WAIT.
   md->digest( IMPORTING ef_hashstring = hash ).
   TRANSLATE hash TO LOWER CASE.
   out->write( |\{"outcome":"ok","headers":1000,"positions":5000,"digest":"{ hash }"\}| ).
  CATCH cx_root.
   ROLLBACK WORK.
   out->write( '{"outcome":"error","code":"SEED_EXCEPTION"}' ).
  ENDTRY.
 ENDMETHOD.
ENDCLASS.
